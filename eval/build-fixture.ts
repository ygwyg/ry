// Builds a large, realistic route manifest from a local cloudflare-docs checkout.
// Usage: node build-fixture.ts [path/to/cloudflare-docs]
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
// --paragraphs: fill missing descriptions from the first paragraph, like the
// manifest builder does for built HTML.
const paragraphs = args.includes("--paragraphs");
const docs = args.find((a) => !a.startsWith("--")) ?? "../../cloudflare-docs";
const root = join(docs, "src/content/docs");
const PRODUCTS = ["workers", "workers-ai", "r2", "d1", "kv", "durable-objects", "queues"];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.mdx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

function field(front: string, name: string) {
  const m = front.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  if (!m) return undefined;
  let v = m[1]!.trim();
  if (v === ">-" || v === ">" || v === "|") {
    // Folded block scalar: take the indented lines that follow.
    const after = front.slice(front.indexOf(m[0]) + m[0].length).split("\n").slice(1);
    v = after.filter((l, i) => /^\s+\S/.test(l) && after.slice(0, i).every((p) => /^\s+\S/.test(p))).map((l) => l.trim()).join(" ");
  }
  return v.replace(/^["']|["']$/g, "") || undefined;
}

function firstParagraph(body: string): string | undefined {
  for (const block of body.split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b || /^(import |export |[<#|>`:-]|\{|\d+\.|\*)/.test(b)) continue;
    const text = b.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (text.length >= 40) return text.slice(0, 200);
  }
  return undefined;
}

const routes = PRODUCTS.flatMap((p) =>
  walk(join(root, p)).flatMap((file) => {
    const src = readFileSync(file, "utf8");
    const front = src.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    if (/^draft:\s*true/m.test(front) || /^external_link:/m.test(front)) return [];
    const rel = relative(root, file).replace(/\.mdx?$/, "");
    const path = "/" + rel.replace(/(^|\/)index$/, "") + "/";
    let description = field(front, "description");
    if (!description && paragraphs) description = firstParagraph(src.slice(src.indexOf("---", 3) + 3));
    return [{ path: path.replace(/\/+/g, "/"), title: field(front, "title"), description }];
  }),
).sort((a, b) => a.path.localeCompare(b.path));

mkdirSync("fixtures", { recursive: true });
const out = paragraphs ? "fixtures/cf-docs-paragraphs.json" : "fixtures/cf-docs.json";
const version = `cf-docs-${routes.length}${paragraphs ? "-p" : ""}`;
writeFileSync(out, JSON.stringify({ version, routes }, null, 1));
console.log(`${routes.length} routes, ${routes.filter((r) => r.description).length} described → ${out}`);
