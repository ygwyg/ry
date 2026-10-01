import { resolveRoute } from "./resolve.js";
import { renderSuggestPage } from "./suggest-page.js";
import type { AiLike, Decision, Manifest, ResolveOptions } from "./types.js";

export type { Decision, Manifest, RouteEntry } from "./types.js";

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

type FetchFn<Env> = (request: Request, env: Env, ctx: Ctx) => Response | Promise<Response>;
type Handler<Env> = { fetch?: FetchFn<Env> } & Record<string, unknown>;

export interface RouteYesOptions<Env> extends ResolveOptions {
  /**
   * Routes to choose from. Defaults to fetching `manifestPath` from the
   * `ASSETS` binding, which the Vite plugin, Astro integration, and CLI write.
   */
  manifest?: Manifest | ((env: Env) => Manifest | Promise<Manifest>);
  /** Default `/route-yes.json`. */
  manifestPath?: string;
  /** Default `env.AI`. */
  ai?: (env: Env) => AiLike;
  /**
   * Prefix for the JSON endpoint SPAs call from their not-found view
   * (`GET {endpoint}/resolve?path=/abuot`). Set `false` to disable. Default `/_route-yes`.
   */
  endpoint?: string | false;
  /** What to do when nothing is confident enough. Default `suggest`. */
  fallback?: "suggest" | "passthrough";
  /** Seconds to cache decisions per path. `0` disables. Default one day. */
  cacheTtl?: number;
  /**
   * KV namespace for caching decisions across locations. Default
   * `env.ROUTE_YES_CACHE` if bound. Recommended on `*.workers.dev`, where the
   * Cache API is unavailable.
   */
  kv?: (env: Env) => KVLike | undefined;
  /** HTTP status for AI redirects. Default `302`, since a model chose it. */
  aiStatus?: 301 | 302 | 307 | 308;
  /** HTTP status for normalization redirects (`/About/` → `/about`). Default `301`. Typo fixes use `aiStatus`. */
  normalizedStatus?: 301 | 302 | 307 | 308;
  /**
   * Static sites only: page to serve on a miss when there's no handler.
   * Default `/404` (your `404.html`). `false` to serve the bare 404.
   */
  notFoundPage?: string | false;
  /** Called for every decision, for logging or analytics. */
  onDecision?: (decision: Decision, request: Request, env: Env) => void | Promise<void>;
  /** Replace the built-in "did you mean" page. */
  renderMiss?: (decision: Decision, original: Response) => Response | Promise<Response>;
}

interface KVLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

const memory = new Map<string, Decision>();
const MEMORY_MAX = 500;

function remember(key: string, d: Decision) {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value!);
  memory.set(key, d);
}

function edgeCache(): Cache | undefined {
  return typeof caches !== "undefined" && "default" in caches
    ? (caches as unknown as { default: Cache }).default
    : undefined;
}

function headerValue(d: Decision) {
  const parts = [d.kind, `confidence=${d.confidence.toFixed(3)}`];
  if (d.to) parts.push(`to=${d.to}`);
  if (d.reason) parts.push(`reason="${d.reason}"`);
  if (d.cached) parts.push("cached");
  else if (d.durationMs !== undefined) parts.push(`ms=${d.durationMs}`);
  return parts.join("; ");
}

function withHeader(res: Response, d: Decision) {
  const out = new Response(res.body, res);
  out.headers.set("x-route-yes", headerValue(d));
  return out;
}

function isNavigation(request: Request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * Wrap a Worker so its 404s get routed by Clef.
 *
 * ```ts
 * // Static site: no handler needed, it serves from env.ASSETS.
 * export default withRouteYes();
 *
 * // SSR framework: wrap its handler.
 * export default withRouteYes(handler);
 * ```
 */
export function withRouteYes<Env = Record<string, unknown>>(
  handler?: Handler<Env> | FetchFn<Env>,
  options: RouteYesOptions<Env> = {},
) {
  const inner: FetchFn<Env> =
    typeof handler === "function"
      ? handler
      : handler?.fetch
        ? handler.fetch.bind(handler)
        : serveAssets;

  const endpoint = options.endpoint === false ? undefined : (options.endpoint ?? "/_route-yes");
  const ttl = options.cacheTtl ?? 86400;
  let manifestPromise: Promise<Manifest> | undefined;

  function assets(env: Env) {
    const binding = (env as { ASSETS?: { fetch: typeof fetch } }).ASSETS;
    if (!binding) throw new Error("route-yes: no handler given and no ASSETS binding found");
    return binding;
  }

  /**
   * Default handler for static sites. Pair it with `not_found_handling: "none"`
   * (otherwise the Worker never sees misses) and it serves your `404.html`.
   */
  async function serveAssets(request: Request, env: Env): Promise<Response> {
    const res = await assets(env).fetch(request);
    if (res.status !== 404 || options.notFoundPage === false) return res;
    const page = new URL(options.notFoundPage ?? "/404", request.url);
    const custom = await assets(env).fetch(page.toString());
    return custom.ok ? new Response(custom.body, { status: 404, headers: custom.headers }) : res;
  }

  function loadManifest(env: Env, origin: string): Promise<Manifest> {
    const m = options.manifest;
    if (m) return Promise.resolve(typeof m === "function" ? m(env) : m);
    manifestPromise ??= (async () => {
      const url = new URL(options.manifestPath ?? "/route-yes.json", origin);
      const res = await assets(env).fetch(url.toString());
      if (!res.ok) throw new Error(`route-yes: ${url.pathname} returned ${res.status}`);
      return (await res.json()) as Manifest;
    })().catch((err) => {
      manifestPromise = undefined;
      throw err;
    });
    return manifestPromise;
  }

  async function decide(path: string, request: Request, env: Env, ctx: Ctx): Promise<Decision> {
    const url = new URL(request.url);
    const manifest = await loadManifest(env, url.origin);
    const model = options.model ?? "clef-flash";
    const key = `https://route-yes.invalid/${manifest.version}/${model}${path}`;
    const cache = ttl > 0 ? edgeCache() : undefined;
    const kv =
      ttl > 0
        ? options.kv
          ? options.kv(env)
          : (env as { ROUTE_YES_CACHE?: KVLike }).ROUTE_YES_CACHE
        : undefined;

    let decision = ttl > 0 ? memory.get(key) : undefined;
    if (!decision && cache) {
      const hit = await cache.match(key);
      if (hit) decision = (await hit.json()) as Decision;
    }
    if (!decision && kv) {
      decision = ((await kv.get(key, "json")) as Decision | null) ?? undefined;
      if (decision) remember(key, decision);
    }
    if (decision) {
      decision = { ...decision, cached: true };
    } else {
      const ai = options.ai ? options.ai(env) : (env as { AI?: AiLike }).AI;
      if (!ai) throw new Error("route-yes: no AI binding found (add `ai` to wrangler config)");
      const started = Date.now();
      decision = await resolveRoute(
        ai,
        manifest,
        { path, referrer: request.headers.get("referer") },
        options,
      );
      decision.durationMs = Date.now() - started;
      if (ttl > 0) {
        remember(key, decision);
        if (cache) {
          const stored = Response.json(decision, {
            headers: { "cache-control": `max-age=${ttl}` },
          });
          ctx.waitUntil(cache.put(key, stored));
        }
        if (kv) {
          ctx.waitUntil(
            kv.put(key, JSON.stringify(decision), { expirationTtl: Math.max(ttl, 60) }),
          );
        }
      }
    }

    // Decisions are cached per path; re-attach this request's query string.
    if (decision.to && url.search && path === url.pathname) {
      decision = { ...decision, to: decision.to.split("?")[0] + url.search };
    }
    if (options.onDecision) ctx.waitUntil(Promise.resolve(options.onDecision(decision, request, env)));
    return decision;
  }

  async function fetchHandler(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);

    if (endpoint && url.pathname === `${endpoint}/resolve`) {
      const site = request.headers.get("sec-fetch-site");
      if (site && site !== "same-origin") return new Response("Forbidden", { status: 403 });
      const path = url.searchParams.get("path");
      if (!path?.startsWith("/")) return Response.json({ error: "path must start with /" }, { status: 400 });
      try {
        return Response.json(await decide(path, request, env, ctx), {
          headers: { "cache-control": "no-store" },
        });
      } catch (err) {
        console.error(err);
        return Response.json({ error: "route-yes failed" }, { status: 500 });
      }
    }

    const res = await inner(request, env, ctx);
    if (res.status !== 404 || !isNavigation(request)) return res;

    let decision: Decision;
    try {
      decision = await decide(url.pathname, request, env, ctx);
    } catch (err) {
      // Never make a 404 worse: fall back to the original response.
      console.error(err);
      return res;
    }

    if (decision.to) {
      const status =
        decision.kind === "normalized"
          ? (options.normalizedStatus ?? 301)
          : (options.aiStatus ?? 302);
      return new Response(null, {
        status,
        headers: { location: decision.to, "x-route-yes": headerValue(decision) },
      });
    }

    if (decision.suggestions.length > 0 && (options.fallback ?? "suggest") === "suggest") {
      if (options.renderMiss) return withHeader(await options.renderMiss(decision, res), decision);
      return new Response(request.method === "HEAD" ? null : renderSuggestPage(decision), {
        status: 404,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-route-yes": headerValue(decision),
        },
      });
    }
    return withHeader(res, decision);
  }

  return typeof handler === "object" && handler
    ? { ...handler, fetch: fetchHandler }
    : { fetch: fetchHandler };
}
