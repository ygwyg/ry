import { describe, expect, it, vi } from "vitest";
import { NONE } from "../src/resolve.js";
import type { Manifest } from "../src/types.js";
import { prefersMarkdown, withRouteYes } from "../src/worker.js";

const manifest: Manifest = {
  version: "w1",
  routes: [
    { path: "/about", title: "About" },
    { path: "/pricing", title: "Pricing" },
  ],
};

function env(probabilities: Record<string, number>) {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? NONE;
  const AI = {
    run: vi.fn(async () => ({
      answers: {
        destination: { choice, probabilities, confidence: 0.9 },
        human: { noul: 0.9 },
      },
    })),
  };
  const ASSETS = {
    fetch: vi.fn(async (input: Request | string) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/route-yes.json") return Response.json(manifest);
      return new Response("<h1>Not found</h1>", { status: 404, headers: { "content-type": "text/html" } });
    }),
  };
  return { AI, ASSETS };
}

const ctx = { waitUntil: () => {} };
const nav = (path: string, init: RequestInit = {}) =>
  new Request(`https://example.com${path}`, { headers: { "sec-fetch-mode": "navigate" }, ...init });

describe("withRouteYes", () => {
  it("redirects static-site 404s using the manifest from ASSETS", async () => {
    const e = env({ "/about": 0.9, [NONE]: 0.1 });
    const res = await withRouteYes(undefined, { cacheTtl: 0 }).fetch(nav("/company?utm=1"), e, ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/about?utm=1");
    expect(res.headers.get("x-route-yes")).toContain("ai;");
  });

  it("leaves non-404s and non-navigation requests alone", async () => {
    const e = env({ "/about": 0.9, [NONE]: 0.1 });
    const ok = await withRouteYes(async () => new Response("hi"), { manifest }).fetch(nav("/x"), e, ctx);
    expect(await ok.text()).toBe("hi");

    const api = new Request("https://example.com/abuot", { headers: { accept: "application/json" } });
    const res = await withRouteYes(undefined, { manifest }).fetch(api, e, ctx);
    expect(res.status).toBe(404);
    expect(e.AI.run).not.toHaveBeenCalled();
  });

  it("renders suggestions on a low-confidence miss", async () => {
    const e = env({ "/about": 0.4, "/pricing": 0.35, [NONE]: 0.25 });
    const res = await withRouteYes(undefined, { manifest, cacheTtl: 0 }).fetch(nav("/company"), e, ctx);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('href="/about"');
    expect(html).toContain('href="/pricing"');
  });

  it("falls back to the original 404 if Clef fails", async () => {
    const e = env({});
    e.AI.run.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await withRouteYes(undefined, { manifest, cacheTtl: 0 }).fetch(nav("/company"), e, ctx);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Not found</h1>");
  });

  it("caches decisions per path", async () => {
    const e = env({ "/pricing": 0.9, [NONE]: 0.1 });
    const worker = withRouteYes(undefined, { manifest: { ...manifest, version: "cache-test" } });
    await worker.fetch(nav("/plans"), e, ctx);
    const res = await worker.fetch(nav("/plans"), e, ctx);
    expect(res.headers.get("x-route-yes")).toContain("cached");
    expect(e.AI.run).toHaveBeenCalledTimes(1);
  });

  it("caches decisions in KV when bound", async () => {
    const store = new Map<string, string>();
    const ROUTE_YES_CACHE = {
      get: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null),
      put: async (k: string, v: string) => void store.set(k, v),
    };
    const waits: Promise<unknown>[] = [];
    const c = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
    const e = { ...env({ "/pricing": 0.9, [NONE]: 0.1 }), ROUTE_YES_CACHE };
    const opts = { manifest: { ...manifest, version: "kv-test" } };

    await withRouteYes(undefined, opts).fetch(nav("/plans-kv"), e, c);
    await Promise.all(waits);
    expect(store.size).toBe(1);
    expect(e.AI.run).toHaveBeenCalledTimes(1);
  });

  it("serves the JSON endpoint for SPAs", async () => {
    const e = env({ "/pricing": 0.9, [NONE]: 0.1 });
    const worker = withRouteYes(undefined, { manifest, cacheTtl: 0 });
    const res = await worker.fetch(
      new Request("https://example.com/_route-yes/resolve?path=/plans", {
        headers: { "sec-fetch-site": "same-origin" },
      }),
      e,
      ctx,
    );
    expect(await res.json()).toMatchObject({ kind: "ai", to: "/pricing" });

    const cross = await worker.fetch(
      new Request("https://example.com/_route-yes/resolve?path=/plans", {
        headers: { "sec-fetch-site": "cross-site" },
      }),
      e,
      ctx,
    );
    expect(cross.status).toBe(403);
  });

  it("decides from Accept whether Markdown is wanted", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
    // Claude Code and other agents list Markdown first at equal weight.
    expect(prefersMarkdown("text/markdown, text/html, */*")).toBe(true);
    expect(prefersMarkdown("text/html, text/markdown")).toBe(false);
    expect(prefersMarkdown("text/html;q=0.5, text/markdown;q=0.9")).toBe(true);
    expect(prefersMarkdown("text/markdown;q=0, text/plain")).toBe(false);
    // A wildcard expresses no preference between the two.
    expect(prefersMarkdown("*/*")).toBe(false);
    expect(prefersMarkdown("text/html,application/xhtml+xml,*/*;q=0.8")).toBe(false);
    expect(prefersMarkdown(null)).toBe(false);
  });

  it("routes agents that ask for Markdown, and answers them in Markdown", async () => {
    const withTwin: Manifest = {
      version: "agents",
      routes: [
        { path: "/about", title: "About" },
        { path: "/pricing", title: "Pricing", markdown: "/pricing.md" },
      ],
      discovery: { sitemap: "/sitemap.xml", llmsTxt: "/llms.txt" },
    };
    const worker = withRouteYes(undefined, { manifest: withTwin, cacheTtl: 0 });
    const agent = (path: string) =>
      new Request(`https://example.com${path}`, { headers: { accept: "text/markdown" } });

    // Never mentions HTML, never sends Sec-Fetch-Mode: still routed.
    const redirect = await worker.fetch(agent("/Pricing"), env({}), ctx);
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/pricing.md");

    const e = env({ "/about": 0.4, "/pricing": 0.35, [NONE]: 0.25 });
    const miss = await worker.fetch(agent("/company"), e, ctx);
    expect(miss.status).toBe(404);
    expect(miss.headers.get("content-type")).toContain("text/markdown");
    expect(miss.headers.get("link")).toBe('</sitemap.xml>; rel="sitemap", </llms.txt>; rel="alternate"; type="text/plain"');
    const body = await miss.text();
    expect(body).toContain("- [About](/about)");
    expect(body).toContain("- [Pricing](/pricing)");
  });

  it("routes a .md path whatever the Accept header says", async () => {
    const worker = withRouteYes(undefined, {
      manifest: { version: "md-path", routes: [{ path: "/pricing", markdown: "/pricing.md" }] },
      cacheTtl: 0,
    });
    const res = await worker.fetch(new Request("https://example.com/PRICING.md", { headers: { accept: "*/*" } }), env({}), ctx);
    expect(res.headers.get("location")).toBe("/pricing.md");
  });

  it("keeps browser and Markdown answers for one path apart in the cache", async () => {
    const withTwin: Manifest = {
      version: "split-cache",
      routes: [{ path: "/pricing", title: "Pricing", markdown: "/pricing.md" }],
    };
    const worker = withRouteYes(undefined, { manifest: withTwin });
    const e = env({ "/pricing": 0.9, [NONE]: 0.1 });
    const html = await worker.fetch(nav("/priceing"), e, ctx);
    const md = await worker.fetch(
      new Request("https://example.com/priceing", { headers: { accept: "text/markdown" } }),
      e,
      ctx,
    );
    expect(html.headers.get("location")).toBe("/pricing");
    expect(md.headers.get("location")).toBe("/pricing.md");
  });

  it("links a browser's 404 to the site's indexes too", async () => {
    const e = env({ "/about": 0.02, [NONE]: 0.98 });
    const res = await withRouteYes(undefined, {
      manifest: { ...manifest, version: "links", discovery: { sitemap: "/sitemap.xml" } },
      cacheTtl: 0,
    }).fetch(nav("/zzz"), e, ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get("link")).toBe('</sitemap.xml>; rel="sitemap"');
    expect(await res.text()).toBe("<h1>Not found</h1>");
  });

  it("keeps other handler exports", async () => {
    const scheduled = () => {};
    const worker = withRouteYes({ fetch: async () => new Response("ok"), scheduled }, { manifest });
    expect((worker as { scheduled?: unknown }).scheduled).toBe(scheduled);
  });
});
