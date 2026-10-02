import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { normalizePath } from "./match.js";
import type { Manifest, RouteEntry } from "./types.js";

export type { Manifest, RouteEntry } from "./types.js";

export interface ManifestOptions {
  /** Built output directory to crawl for `.html` files. */
  outDir?: string;
  /** Extra routes, as paths or full entries. These win over discovered ones. */
  routes?: (string | RouteEntry)[];
  /** Path to a TanStack Router `routeTree.gen.ts` to read static routes from. */
  tanstackRouteTree?: string;
  /** Glob-free path prefixes to leave out, e.g. `["/admin", "/drafts"]`. */
  exclude?: string[];
  /**
   * Your site's origin, e.g. `https://example.com`. Absolute links in
   * `llms.txt` count as pages only when they point here. Defaults to the
   * host your sitemap uses.
   */
  site?: string;
}

const SKIP_FILES = /^(?:404|500|_?error)\.html?$/i;

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function clean(s: string | undefined, max: number) {
  if (!s) return undefined;
  const text = decodeEntities(s).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function metaContent(html: string, name: string) {
  const tag = html.match(
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i"),
  )?.[0];
  const m = tag?.match(/content=(?:"([^"]*)"|'([^']*)')/i);
  return m?.[1] ?? m?.[2];
}

/** The first real paragraph of the page's main content, as plain text. */
function firstParagraph(html: string): string | undefined {
  const body =
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ??
    "";
  for (const [, inner] of body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = inner!.replace(/<[^>]+>/g, "").trim();
    if (text.length >= 40) return text;
  }
  return undefined;
}

/** Pull a title and description out of a built HTML page. */
export function extractPageInfo(html: string): { title?: string; description?: string; noindex: boolean } {
  const robots = metaContent(html, "robots") ?? "";
  return {
    title: clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1], 120)
      ?? clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, ""), 120),
    description: clean(
      metaContent(html, "description") ?? metaContent(html, "og:description") ?? firstParagraph(html),
      200,
    ),
    noindex: /noindex/i.test(robots),
  };
}

/**
 * Map an output file to the URL Workers Static Assets serves it at
 * (default `auto-trailing-slash` html_handling).
 */
export function fileToPath(file: string): string {
  const rel = file.split(sep).join("/");
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"index.html".length)}`;
  return `/${rel.replace(/\.html?$/, "")}`;
}

async function walk(dir: string, match = /\.html?$/i): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(full, match);
      return match.test(e.name) ? [full] : [];
    }),
  );
  return files.flat();
}

/**
 * The page a Markdown URL is the twin of: `/pricing.md` → `/pricing`,
 * `/docs/index.md` → `/docs/`, `/index.md` → `/`.
 */
export function markdownToPage(url: string): string {
  if (url === "/index.md") return "/";
  if (url.endsWith("/index.md")) return url.slice(0, -"index.md".length);
  return url.replace(/\.md$/, "");
}

/**
 * Find Markdown versions of pages in `outDir` (`pricing.md` beside
 * `pricing.html`, or `docs/index.md`), keyed by normalized page path.
 */
export async function findMarkdownTwins(outDir: string): Promise<Map<string, string>> {
  const twins = new Map<string, string>();
  if (!existsSync(outDir)) return twins;
  for (const file of await walk(outDir, /\.md$/i)) {
    const url = `/${relative(outDir, file).split(sep).join("/")}`;
    twins.set(normalizePath(markdownToPage(url)), url);
  }
  return twins;
}

/**
 * Discover routes from an `llms.txt` file (https://llmstxt.org): every list
 * item of the form `- [Title](url): description`. Links to other sites are
 * left out; pass `site` so absolute links to this one count. A link to a
 * `.md` file becomes the page it describes, with `markdown` set and
 * `markdownOnly` until another source shows an HTML page lives there.
 */
export function parseLlmsTxt(text: string, site?: string): RouteEntry[] {
  const host = site ? safeUrl(site)?.host : undefined;
  const routes: RouteEntry[] = [];
  for (const [, title, href, description] of text.matchAll(
    /^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)(?::\s*(.+))?$/gm,
  )) {
    let path: string | undefined;
    if (href!.startsWith("/") && !href!.startsWith("//")) path = href!.split(/[?#]/)[0];
    else {
      const url = safeUrl(href!);
      if (url && host && url.host === host) path = url.pathname;
    }
    if (!path) continue;
    const isMarkdown = /\.md$/i.test(path);
    routes.push({
      path: isMarkdown ? markdownToPage(path) : path,
      title: clean(title, 120),
      description: clean(description, 200),
      ...(isMarkdown ? { markdown: path, markdownOnly: true } : {}),
    });
  }
  return routes;
}

function safeUrl(s: string) {
  try {
    return new URL(s);
  } catch {
    return undefined;
  }
}

/** Discover routes from built HTML in `outDir`. */
export async function crawlHtml(outDir: string): Promise<RouteEntry[]> {
  if (!existsSync(outDir)) return [];
  const routes: RouteEntry[] = [];
  for (const file of await walk(outDir)) {
    const rel = relative(outDir, file);
    if (SKIP_FILES.test(rel)) continue;
    const info = extractPageInfo(await readFile(file, "utf8"));
    if (info.noindex) continue;
    routes.push({ path: fileToPath(rel), title: info.title, description: info.description });
  }
  return routes;
}

/** Discover static routes from `<loc>` entries in a sitemap. */
export function parseSitemap(xml: string): RouteEntry[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].flatMap(([, loc]) => {
    try {
      return [{ path: new URL(decodeEntities(loc!)).pathname }];
    } catch {
      return [];
    }
  });
}

/**
 * Discover static routes from TanStack Router's generated route tree.
 * Dynamic (`$param`) and pathless (`_layout`) routes are left out, since
 * there's no concrete URL to send anyone to.
 */
export function parseTanstackRouteTree(source: string): RouteEntry[] {
  const block = source.match(/interface FileRoutesByFullPath\s*{([\s\S]*?)\n}/)?.[1];
  if (!block) return [];
  return [...block.matchAll(/^\s*['"]([^'"]+)['"]\s*:/gm)]
    .map(([, path]) => path!)
    .filter((p) => !p.includes("$") && !/\/_/.test(p))
    .map((path) => ({ path }));
}

function versionOf(routes: RouteEntry[]) {
  return createHash("sha256").update(JSON.stringify(routes)).digest("hex").slice(0, 12);
}

/**
 * Merge route lists, letting later entries fill in or override earlier ones.
 * A route stays `markdownOnly` only if every source that names it says so.
 */
export function mergeRoutes(...lists: RouteEntry[][]): RouteEntry[] {
  const byPath = new Map<string, RouteEntry>();
  for (const list of lists) {
    for (const r of list) {
      const prev = byPath.get(r.path);
      const markdownOnly = !!r.markdownOnly && (!prev || !!prev.markdownOnly);
      byPath.set(r.path, {
        path: r.path,
        title: r.title ?? prev?.title,
        description: r.description ?? prev?.description,
        ...((r.markdown ?? prev?.markdown) ? { markdown: r.markdown ?? prev?.markdown } : {}),
        ...(markdownOnly ? { markdownOnly } : {}),
      });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// The last " · Site", " | Site", or " - Site". Separators need spaces around
// them, so names like "clef•ai•ry" survive intact.
const SUFFIX = /\s[|·•\-–—]\s(?!.*\s[|·•\-–—]\s).+$/;

/**
 * Drop a site-name suffix ("Pricing · Acme") shared by most titles. It's
 * noise for Clef and for suggestion lists.
 */
export function stripSiteSuffix(routes: RouteEntry[]): RouteEntry[] {
  const counts = new Map<string, number>();
  for (const r of routes) {
    const m = r.title?.match(SUFFIX);
    if (m) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  const [suffix, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!suffix || !n || n < 2 || n < routes.length / 2) return routes;
  return routes.map((r) =>
    r.title?.endsWith(suffix) ? { ...r, title: r.title.slice(0, -suffix.length) } : r,
  );
}

/** Build a manifest from every source available. */
export async function buildManifest(opts: ManifestOptions): Promise<Manifest> {
  const lists: RouteEntry[][] = [];
  const discovery: NonNullable<Manifest["discovery"]> = {};
  let twins = new Map<string, string>();

  if (opts.outDir) {
    // sitemap.xml, or @astrojs/sitemap's sitemap-index.xml + sitemap-0.xml.
    const sitemaps = existsSync(opts.outDir)
      ? (await readdir(opts.outDir)).filter((f) => /^sitemap.*\.xml$/.test(f)).sort()
      : [];
    let site = opts.site;
    for (const f of sitemaps) {
      const xml = await readFile(join(opts.outDir, f), "utf8");
      site ??= xml.match(/<loc>\s*(https?:\/\/[^/<\s]+)/)?.[1];
      const entries = parseSitemap(xml);
      lists.push(entries.filter((r) => !r.path.endsWith(".xml")));
    }
    const index = sitemaps.find((f) => f === "sitemap-index.xml") ?? sitemaps.find((f) => f === "sitemap.xml") ?? sitemaps[0];
    if (index) discovery.sitemap = `/${index}`;

    // Before the HTML crawl, so a page's own <title> wins over its llms.txt label.
    const llms = join(opts.outDir, "llms.txt");
    if (existsSync(llms)) {
      discovery.llmsTxt = "/llms.txt";
      lists.push(parseLlmsTxt(await readFile(llms, "utf8"), site));
    }
    lists.push(await crawlHtml(opts.outDir));
    twins = await findMarkdownTwins(opts.outDir);
  }
  if (opts.tanstackRouteTree && existsSync(opts.tanstackRouteTree)) {
    lists.push(parseTanstackRouteTree(await readFile(opts.tanstackRouteTree, "utf8")));
  }
  if (opts.routes) {
    lists.push(opts.routes.map((r) => (typeof r === "string" ? { path: r } : r)));
  }

  const exclude = opts.exclude ?? [];
  const routes = stripSiteSuffix(
    mergeRoutes(...lists)
      .filter((r) => r.path.startsWith("/") && !exclude.some((x) => r.path.startsWith(x)))
      // A Markdown file in outDir only becomes a twin of a page that exists. A
      // .md link in llms.txt with no page behind it stays markdownOnly, so
      // only Markdown requests are ever sent there.
      .map((r) => {
        const twin = r.markdown ?? twins.get(normalizePath(r.path));
        return twin ? { ...r, markdown: twin } : r;
      }),
  );
  return {
    version: versionOf(routes),
    routes,
    ...(Object.keys(discovery).length ? { discovery } : {}),
  };
}

/** Build a manifest and write it to `{outDir}/route-yes.json`. */
export async function writeManifest(opts: ManifestOptions & { outDir: string }) {
  const manifest = await buildManifest(opts);
  const file = join(opts.outDir, "route-yes.json");
  await writeFile(file, JSON.stringify(manifest, null, 2));
  return { file, manifest };
}
