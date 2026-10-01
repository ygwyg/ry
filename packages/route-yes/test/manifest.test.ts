import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  extractPageInfo,
  fileToPath,
  markdownToPage,
  parseLlmsTxt,
  parseSitemap,
  parseTanstackRouteTree,
  stripSiteSuffix,
} from "../src/manifest.js";

describe("manifest", () => {
  it("maps files to served paths", () => {
    expect(fileToPath("index.html")).toBe("/");
    expect(fileToPath("about.html")).toBe("/about");
    expect(fileToPath(join("blog", "index.html"))).toBe("/blog/");
    expect(fileToPath(join("blog", "post.html"))).toBe("/blog/post");
  });

  it("extracts titles and descriptions", () => {
    const info = extractPageInfo(
      `<title> Pricing &amp; plans </title><meta name="description" content="What it costs">`,
    );
    expect(info).toEqual({ title: "Pricing & plans", description: "What it costs", noindex: false });
    expect(extractPageInfo(`<meta name="robots" content="noindex">`).noindex).toBe(true);
    expect(
      extractPageInfo(`<nav><p>Skip</p></nav><main><p>Short.</p><p>Store <b>large objects</b> without paying for egress bandwidth.</p></main>`)
        .description,
    ).toBe("Store large objects without paying for egress bandwidth.");
    expect(extractPageInfo(`<meta name="description" content="We're hiring">`).description).toBe("We're hiring");
    expect(extractPageInfo(`<meta name='description' content='Say "hi"'>`).description).toBe('Say "hi"');
  });

  it("parses sitemaps and TanStack route trees", () => {
    expect(parseSitemap("<url><loc>https://x.com/a</loc></url><url><loc>https://x.com/b/</loc></url>")).toEqual([
      { path: "/a" },
      { path: "/b/" },
    ]);
    const tree = `
export interface FileRoutesByFullPath {
  '/': typeof IndexRoute
  '/about': typeof AboutRoute
  '/posts/$postId': typeof PostsPostIdRoute
  '/posts': typeof PostsIndexRoute
}
export interface FileRoutesByTo {}`;
    expect(parseTanstackRouteTree(tree).map((r) => r.path)).toEqual(["/", "/about", "/posts"]);
  });

  it("strips a site-wide title suffix", () => {
    const routes = stripSiteSuffix([
      { path: "/", title: "Acme" },
      { path: "/a", title: "Pricing · Acme" },
      { path: "/b", title: "Docs · Acme" },
      { path: "/d", title: "Tips · Tricks · Acme" },
      { path: "/c", title: "Q&A - the basics" },
    ]);
    expect(stripSiteSuffix([{ path: "/", title: "A · clef•ai•ry" }, { path: "/b", title: "B · clef•ai•ry" }])
      .map((r) => r.title)).toEqual(["A", "B"]);
    expect(routes.map((r) => r.title)).toEqual(["Acme", "Pricing", "Docs", "Tips · Tricks", "Q&A - the basics"]);
  });

  it("maps Markdown URLs to the pages they describe", () => {
    expect(markdownToPage("/pricing.md")).toBe("/pricing");
    expect(markdownToPage("/docs/index.md")).toBe("/docs/");
    expect(markdownToPage("/index.md")).toBe("/");
  });

  it("parses llms.txt links, keeping only this site's", () => {
    const llms = `# Acme

> Acme sells widgets.

## Docs

- [Pricing](https://acme.dev/pricing.md): Plans and billing
- [Getting started](/docs/getting-started)
- [Our GitHub](https://github.com/acme/acme): Source code
- [Status](//status.acme.dev)
`;
    expect(parseLlmsTxt(llms, "https://acme.dev")).toEqual([
      { path: "/pricing", title: "Pricing", description: "Plans and billing", markdown: "/pricing.md" },
      { path: "/docs/getting-started", title: "Getting started", description: undefined },
    ]);
    // Without knowing the site's origin, only relative links count.
    expect(parseLlmsTxt(llms).map((r) => r.path)).toEqual(["/docs/getting-started"]);
  });

  it("reads Markdown twins, llms.txt, and the sitemap's location", async () => {
    const dir = await mkdtemp(join(tmpdir(), "route-yes-"));
    await mkdir(join(dir, "docs"));
    await writeFile(join(dir, "pricing.html"), "<title>Pricing</title>");
    await writeFile(join(dir, "pricing.md"), "# Pricing");
    await writeFile(join(dir, "docs", "index.html"), "<title>Docs</title>");
    await writeFile(join(dir, "docs", "index.md"), "# Docs");
    // A Markdown file with no page beside it is not a route.
    await writeFile(join(dir, "README.md"), "# readme");
    await writeFile(join(dir, "sitemap.xml"), "<urlset><url><loc>https://acme.dev/pricing</loc></url></urlset>");
    await writeFile(
      join(dir, "llms.txt"),
      "# Acme\n\n- [Plans](https://acme.dev/pricing): What it costs\n- [Changelog](https://acme.dev/changelog.md)\n",
    );

    const m = await buildManifest({ outDir: dir });
    expect(m.routes).toEqual([
      { path: "/changelog", title: "Changelog", markdown: "/changelog.md" },
      { path: "/docs/", title: "Docs", markdown: "/docs/index.md" },
      // The page's own <title> wins; llms.txt fills in the description.
      { path: "/pricing", title: "Pricing", description: "What it costs", markdown: "/pricing.md" },
    ]);
    expect(m.discovery).toEqual({ sitemap: "/sitemap.xml", llmsTxt: "/llms.txt" });
  });

  it("crawls a build directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "route-yes-"));
    await mkdir(join(dir, "docs"));
    await writeFile(join(dir, "index.html"), "<title>Home</title>");
    await writeFile(join(dir, "404.html"), "<title>Not found</title>");
    await writeFile(join(dir, "docs", "index.html"), "<h1>Docs <em>home</em></h1>");
    await writeFile(join(dir, "draft.html"), `<meta name="robots" content="noindex">`);

    const m = await buildManifest({ outDir: dir, routes: ["/contact"], exclude: ["/secret"] });
    expect(m.routes).toEqual([
      { path: "/", title: "Home" },
      { path: "/contact" },
      { path: "/docs/", title: "Docs home" },
    ]);
    expect(m.version).toMatch(/^[0-9a-f]{12}$/);
  });
});
