import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    worker: "src/worker.ts",
    client: "src/client.ts",
    manifest: "src/manifest.ts",
    vite: "src/vite.ts",
    astro: "src/astro.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  external: ["vite"],
});
