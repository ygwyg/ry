import { fileURLToPath } from "node:url";
import { writeManifest, type ManifestOptions } from "./manifest.js";

// Structural subset of Astro's AstroIntegration, so astro isn't a build dependency.
interface AstroIntegration {
  name: string;
  hooks: {
    "astro:build:done"?: (params: {
      dir: URL;
      logger: { info(message: string): void };
    }) => Promise<void>;
  };
}

/**
 * Astro integration: after the build, crawls the generated pages (and
 * `sitemap.xml`, if `@astrojs/sitemap` is installed) into `route-yes.json`.
 */
export function routeYes(options: Omit<ManifestOptions, "outDir"> = {}): AstroIntegration {
  return {
    name: "route-yes",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const { manifest } = await writeManifest({ ...options, outDir: fileURLToPath(dir) });
        logger.info(`${manifest.routes.length} routes written to route-yes.json`);
      },
    },
  };
}

export default routeYes;
