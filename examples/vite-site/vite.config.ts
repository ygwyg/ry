import { resolve } from "node:path";
import { defineConfig } from "vite";
import { routeYes } from "route-yes/vite";

const pages = [
  "index",
  "404",
  "about/index",
  "pricing/index",
  "careers/index",
  "changelog/index",
  "blog/hello-world/index",
  "docs/getting-started/index",
  "docs/api-reference/index",
];

export default defineConfig({
  plugins: [routeYes()],
  build: {
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p, resolve(__dirname, `${p}.html`)])),
    },
  },
});
