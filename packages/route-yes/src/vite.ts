import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import { writeManifest, type ManifestOptions } from "./manifest.js";

export interface RouteYesViteOptions extends Omit<ManifestOptions, "outDir"> {
  /**
   * Vite environment whose output holds the site's pages. Default `client`,
   * which is what `@cloudflare/vite-plugin` and SSR frameworks use.
   */
  environment?: string;
}

/**
 * Writes `route-yes.json` next to your built pages so the Worker knows which
 * routes exist. Works with plain Vite, `@cloudflare/vite-plugin`, TanStack
 * Router/Start, React Router, and anything else built on Vite.
 *
 * Pages prerendered after Vite finishes (some SSR frameworks) won't be
 * crawled here; run `route-yes manifest <dir>` after your build instead.
 */
export function routeYes(options: RouteYesViteOptions = {}): Plugin {
  let config: ResolvedConfig;
  const target = options.environment ?? "client";

  return {
    name: "route-yes",
    apply: "build",
    configResolved(c) {
      config = c;
    },
    async writeBundle(output) {
      const envName = (this as { environment?: { name: string } }).environment?.name;
      if (envName && envName !== target) return;

      const outDir = output.dir ?? resolve(config.root, config.build.outDir);
      const defaultTree = resolve(config.root, "src/routeTree.gen.ts");
      const { file, manifest } = await writeManifest({
        ...options,
        outDir,
        tanstackRouteTree:
          options.tanstackRouteTree ?? (existsSync(defaultTree) ? defaultTree : undefined),
      });
      config.logger.info(
        `route-yes: ${manifest.routes.length} routes → ${file.slice(config.root.length + 1)}`,
      );
    },
  };
}

export default routeYes;
