# ry evaluation

These scripts measure how well ry routes broken URLs on a large, real site. The latest numbers are in [RESULTS.md](RESULTS.md).

## Run it

```sh
# 1. Build the test site from a local cloudflare-docs checkout
#    (https://github.com/cloudflare/cloudflare-docs)
node build-fixture.ts ../../cloudflare-docs
node build-fixture.ts ../../cloudflare-docs --paragraphs

# 2. Start the eval Worker. It uses the real Clef and embedding models.
CLOUDFLARE_ACCOUNT_ID=… pnpm dev

# 3. In another shell, run every configuration, or name some
node run.ts
node run.ts rerank-5 no-rerank
```

A full run of one configuration makes about 75 Clef calls. Typos and bot probes don't call Clef.

## Files

- `cases.ts`: the labeled broken URLs. Typos are generated from a fixed seed, and the rest are written by hand. Each case lists every acceptable destination, or none.
- `run.ts`: the configurations under test and the scoring. Raw results go to `results/`, which is gitignored.
- `src/worker.ts`: runs `resolveRoute` inside a Worker so it can use the `AI` binding.
