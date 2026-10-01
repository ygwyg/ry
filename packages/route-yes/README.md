<p align="center">
  <img src="https://raw.githubusercontent.com/ygwyg/ry/main/assets/ry.jpeg" width="160" alt="ry, a pixel-art Clefairy">
  <br>
  <b>clef•ai•ry</b>
</p>

<h1 align="center">ry</h1>

<p align="center"><i>ry stands for <b>route yes</b>.</i></p>

<p align="center"><a href="https://route-yes-example.burcs.workers.dev">Live demo</a> · try <a href="https://route-yes-example.burcs.workers.dev/priceing">/priceing</a>, <a href="https://route-yes-example.burcs.workers.dev/jobs">/jobs</a>, or <a href="https://route-yes-example.burcs.workers.dev/release-notes">/release-notes</a></p>

<p align="center"><img src="https://raw.githubusercontent.com/ygwyg/ry/main/assets/demo.gif" alt="Demo: clicking broken links on the example site; ry redirects /priceing to Pricing, /docs/quickstart to Getting started, and shows suggestions for /our-team" width="760"></p>

**An AI router for 404s.** When someone hits a URL that doesn't exist, route-yes asks [Cloudflare Clef](https://blog.cloudflare.com/clef-decision-models/) which real page they meant, and sends them there.

```
/priceing                  → 302 /pricing/              (ai, 0.88)
/docs/quickstart           → 302 /docs/getting-started/ (ai, 0.88)
/jobs                      → 302 /careers/              (ai, 0.82)
/release-notes             → 302 /changelog/            (ai, 0.92)
/how-much-does-it-cost?x=1 → 302 /pricing/?x=1          (ai, 0.88)
/About/                    → 301 /about/                (normalized, no AI call)
/our-team                  → 404 "did you mean: Careers, About Acme?"
/wp-admin/setup.php        → 404                        (skipped, no AI call)
```

These are real results from Clef running against [`examples/vite-site`](https://github.com/ygwyg/ry/tree/main/examples/vite-site).

## Why Clef

Clef is a *decision* model: you give it a state and typed questions, and it returns a calibrated probability for every allowed answer. It doesn't generate text. That fits this problem well:

- **It can't hallucinate a URL.** The routes are the `choice` options, so Clef can only pick a page that exists, or `none`.
- **Calibrated probabilities** give a usable confidence threshold: redirect when sure, show suggestions when unsure, do nothing when it's `none`.
- **A `noul` (yes/no) question in the same call** tells people from scanners, so bots probing `/admin-backup` don't get redirected.
- **It's cheap and fast.** `clef-flash` is billed per input token ($0.24/M), and decisions are cached per path.

## How it works

1. Your Worker returns a 404 for a page navigation.
2. **Normalize.** Case, slashes, `.html`, and `/index` differences are fixed with a 301 and no AI call.
3. **Skip.** Asset requests (`.js`, `.png`, …) and obvious probes (`.env`, `wp-admin`, `.php`) keep their 404.
4. **Prefilter.** A lexical score trims the route list to the top 60 candidates (Clef accepts up to 255 options).
5. **Ask Clef** with one `choice` question ("which page did they mean?", including `none`) and one `noul` question ("is this a person?").
6. **Act.** A confident answer (≥ 0.7) gets a 302 with the query string preserved. A partial match gets a "did you mean" 404 page. Anything else keeps the original 404.
7. **Cache** the decision per path in isolate memory, the Cache API, and KV (if you bind `ROUTE_YES_CACHE`). The cache resets whenever the route manifest changes.

Every response carries an `x-route-yes` header explaining the decision, including how long Clef took (`ms=`). Any failure falls back to your original 404.

## Install

```sh
npm i route-yes
```

route-yes has two parts:

- **Build time:** a plugin writes `route-yes.json`, the list of real pages with titles and descriptions.
- **Runtime:** a Worker wrapper uses that list to route 404s.

### Vite (plain, React, Vue, Svelte, TanStack Router, React Router…)

```ts
// vite.config.ts
import { routeYes } from "route-yes/vite";
export default defineConfig({ plugins: [routeYes()] });
```

The plugin crawls built HTML, `sitemap*.xml`, and `src/routeTree.gen.ts` (TanStack Router), and accepts extra routes: `routeYes({ routes: ["/pricing", { path: "/docs", title: "Documentation" }] })`.

### Astro

```ts
// astro.config.mjs
import routeYes from "route-yes/astro";
export default defineConfig({ integrations: [routeYes()] });
```

### Anything else

```sh
your-build && npx route-yes manifest dist
```

Use this for frameworks that prerender after Vite finishes, or for any static output directory.

## Runtime

### Static sites

```ts
// worker/index.ts
import { withRouteYes } from "route-yes/worker";
export default withRouteYes();
```

```jsonc
// wrangler.jsonc
{
  "main": "worker/index.ts",
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "none" // required, see below
  },
  "ai": { "binding": "AI" },
  // Optional but recommended, especially on *.workers.dev where the Cache API is unavailable
  "kv_namespaces": [{ "binding": "ROUTE_YES_CACHE", "id": "<from: wrangler kv namespace create ROUTE_YES_CACHE>" }]
}
```

> With `not_found_handling` set to `404-page` or `single-page-application`, the assets layer answers misses itself and the Worker never runs. Use `"none"`; route-yes still serves your `404.html` on a miss.

### SSR frameworks (Astro SSR, TanStack Start, React Router, Hono…)

Wrap whatever your adapter exports. Every 404 navigation it returns goes through route-yes:

```ts
import handler from "./dist/_worker.js"; // or your framework's server entry
import { withRouteYes } from "route-yes/worker";
export default withRouteYes(handler);
```

### SPAs (the 404 happens in the browser)

In an SPA, the server returns `index.html` for every URL, so the not-found view asks the Worker instead:

```tsx
// TanStack Router
import { routeYes } from "route-yes/client";

export const Route = createRootRoute({
  notFoundComponent: () => {
    const navigate = useNavigate();
    const [suggestions, setSuggestions] = useState([]);
    useEffect(() => {
      routeYes({ navigate: (to) => navigate({ to, replace: true }) })
        .then((d) => setSuggestions(d?.suggestions ?? []));
    }, []);
    return <NotFound suggestions={suggestions} />;
  },
});
```

Add `"run_worker_first": ["/_route-yes/*"]` to `assets` so the endpoint always reaches the Worker.

## Options

```ts
withRouteYes(handler, {
  model: "clef-flash",          // or "clef" for the full model
  minConfidence: 0.7,           // probability needed to redirect
  minHumanLikelihood: 0.5,      // below this, it's treated as a bot
  maxCandidates: 60,            // routes sent to Clef after prefiltering (max 254)
  siteDescription: "Acme, a developer platform", // helps with ambiguous paths
  fallback: "suggest",          // or "passthrough" to keep your own 404 page
  cacheTtl: 86400,              // seconds; 0 disables caching
  kv: (env) => env.MY_KV,       // decision cache; defaults to env.ROUTE_YES_CACHE
  aiStatus: 302,                // a model picked it, so not permanent by default
  normalizedStatus: 301,
  endpoint: "/_route-yes",      // SPA endpoint; false disables it
  manifest: undefined,          // pass routes directly instead of /route-yes.json
  onDecision: (d) => console.log(d), // logging or Analytics Engine
  renderMiss: (d, original) => myNotFoundPage(d.suggestions),
});
```

Use the core resolver anywhere, with the binding or the REST API:

```ts
import { resolveRoute, restAi } from "route-yes";
const ai = restAi({ accountId, apiToken });
await resolveRoute(ai, manifest, { path: "/priceing" });
```

Or from the terminal:

```sh
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… npx route-yes try /priceing --manifest dist/route-yes.json
```

## Notes

- **Latency.** Each uncached Clef call took 0.5–4.5s in production during launch week, not the ~40ms Cloudflare quotes for `clef-flash`. Cached decisions skip Clef entirely, so bind KV.
- **Borderline paths can flip.** Clef's confidence for the same kind of path varies between calls (`/jobs` scored 0.65–0.82 across runs), so a path near `minConfidence` may redirect once and show suggestions another time. The first decision is then cached for `cacheTtl`.
- **Cost control.** Only page navigations that 404 call Clef, and each unique path is decided once per cache TTL. On a public site, consider adding a [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) in `onDecision` or in front of the Worker; random-path floods are the main cost risk.
- **SEO.** AI redirects are 302s by default so search engines don't treat a model's guess as permanent. The suggestions page sends `noindex`.
- **Safety.** Redirect targets can only come from your manifest, so there's no open redirect. A route that is in the manifest but still 404s is never redirected to itself.
- **Dynamic routes** like `/posts/$id` aren't targets. Concrete pages (from prerendered HTML or the sitemap) are.

## Develop

```sh
pnpm install
pnpm test                       # unit tests (mocked Clef)
cd examples/vite-site && pnpm dev   # real Clef via wrangler dev (AI binding is always remote)
```
