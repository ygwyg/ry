import type { RouteEntry } from "./types.js";

/**
 * Collapse the boring differences between URLs: case, duplicate or trailing
 * slashes, `.html` and `.md` extensions, `/index`, and percent-encoding.
 */
export function normalizePath(path: string): string {
  let p = path;
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed escapes: keep the raw path.
  }
  p = p.toLowerCase().replace(/\/{2,}/g, "/");
  p = p.replace(/\.(?:html?|md)$/, "").replace(/\/index$/, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

/**
 * Return the single route that `path` matches after normalization, or
 * undefined if there are none or several.
 */
export function findNormalizedMatch(
  path: string,
  routes: RouteEntry[],
): RouteEntry | undefined {
  const target = normalizePath(path);
  const hits = routes.filter((r) => normalizePath(r.path) === target);
  return hits.length === 1 ? hits[0] : undefined;
}

const ASSET_EXT =
  /\.(?:js|mjs|cjs|css|map|json|xml|txt|ico|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|wasm)$/i;

// Paths that are almost always scanners, not people. Not worth an AI call.
const PROBE =
  /(?:^|\/)(?:\.env|\.git|\.aws|\.ssh|\.ds_store|wp-admin|wp-login|wp-content|wp-includes|xmlrpc|phpmyadmin|cgi-bin|vendor\/phpunit|actuator|server-status)|\.(?:php\d?|asp|aspx|jsp|cgi|env|ini|bak|sql|yml|yaml|config)$/i;

/** Return a reason to skip AI routing for this path, or undefined to proceed. */
export function skipReason(path: string): string | undefined {
  if (path.length > 512) return "path too long";
  if (PROBE.test(path)) return "looks like a bot probe";
  if (ASSET_EXT.test(path)) return "asset request";
  return undefined;
}

/** Split a path or phrase into lowercase word tokens. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/**
 * Cheap lexical score of how plausibly `path` was meant to be `route`.
 * Only used to trim the candidate list before asking Clef, so it favors recall.
 */
export function lexicalScore(path: string, route: RouteEntry): number {
  const want = tokenize(path);
  if (want.length === 0) return 0;
  const routeTokens = tokenize(route.path);
  const textTokens = new Set([
    ...routeTokens,
    ...tokenize(route.title ?? ""),
    ...tokenize(route.description ?? ""),
  ]);

  let total = 0;
  for (const w of want) {
    let best = textTokens.has(w) ? 1 : 0;
    for (const t of routeTokens) {
      if (best === 1) break;
      if (t.startsWith(w) || w.startsWith(t)) best = Math.max(best, 0.8);
      best = Math.max(best, similarity(w, t));
    }
    total += best;
  }
  const wholePath = similarity(normalizePath(path), normalizePath(route.path));
  return total / want.length + 0.5 * wholePath;
}

/** Pick the `limit` routes most worth showing to Clef. */
export function prefilter(
  path: string,
  routes: RouteEntry[],
  limit: number,
): RouteEntry[] {
  if (routes.length <= limit) return routes;
  return routes
    .map((route) => ({ route, score: lexicalScore(path, route) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.route);
}
