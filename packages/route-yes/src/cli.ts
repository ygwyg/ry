#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { writeManifest } from "./manifest.js";
import { resolveRoute } from "./resolve.js";
import { restAi } from "./rest.js";
import { readFile } from "node:fs/promises";
import type { ClefModel, Manifest } from "./types.js";

const USAGE = `route-yes — AI routing for 404s, powered by Cloudflare Clef

Usage:
  route-yes manifest <outDir> [--route /path]... [--exclude /prefix]... [--tanstack src/routeTree.gen.ts] [--site https://example.com]
      Write <outDir>/route-yes.json from built HTML, sitemap.xml, llms.txt, Markdown pages, and extra routes.

  route-yes try <path> [--manifest dist/route-yes.json] [--model clef|clef-flash]
      Ask Clef where <path> should go. Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      route: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      tanstack: { type: "string" },
      site: { type: "string" },
      manifest: { type: "string", default: "dist/route-yes.json" },
      model: { type: "string", default: "clef-flash" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, arg] = positionals;

  if (values.help || !command || !arg) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  if (command === "manifest") {
    const { file, manifest } = await writeManifest({
      outDir: resolve(arg),
      routes: values.route,
      exclude: values.exclude,
      tanstackRouteTree: values.tanstack && resolve(values.tanstack),
      site: values.site,
    });
    console.log(`route-yes: ${manifest.routes.length} routes → ${file}`);
    return;
  }

  if (command === "try") {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
    const manifest = JSON.parse(await readFile(values.manifest!, "utf8")) as Manifest;
    const started = performance.now();
    const decision = await resolveRoute(restAi({ accountId, apiToken }), manifest, { path: arg }, {
      model: values.model as ClefModel,
    });
    console.log(JSON.stringify(decision, null, 2));
    console.log(`(${Math.round(performance.now() - started)}ms)`);
    return;
  }

  console.log(USAGE);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
