import { lexicalScore, tokenize } from "./match.js";
import type { AiLike, Manifest, ResolveOptions, RouteEntry } from "./types.js";

export const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

// bge v1.5 retrieves better when short queries carry this instruction.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const BATCH = 100;
// Reciprocal rank fusion constant; 60 is the usual choice.
const RRF_K = 60;

/** Turn `/workers/cron-triggers/` into `workers cron triggers`. */
export function humanizePath(path: string): string {
  return tokenize(path).join(" ");
}

/** The text a route is embedded as. */
export function routeText(r: RouteEntry): string {
  return [r.title, r.description, humanizePath(r.path)].filter(Boolean).join(". ");
}

function unwrapVectors(raw: unknown): number[][] {
  const out = ((raw as { result?: unknown })?.result ?? raw) as { data?: number[][] };
  if (!Array.isArray(out?.data)) throw new Error("route-yes: unexpected embedding response");
  return out.data;
}

async function embed(ai: AiLike, model: string, texts: string[]): Promise<number[][]> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) batches.push(texts.slice(i, i + BATCH));
  const results = await Promise.all(
    batches.map(async (text) => unwrapVectors(await ai.run(model, { text }))),
  );
  return results.flat();
}

function normalize(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

function dot(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

// Route vectors per manifest version, so each isolate embeds the site once.
const routeVectors = new Map<string, Promise<Float32Array[]>>();

function vectorsFor(ai: AiLike, manifest: Manifest, model: string) {
  const key = `${model}:${manifest.version}`;
  let pending = routeVectors.get(key);
  if (!pending) {
    pending = embed(ai, model, manifest.routes.map(routeText)).then((vs) => vs.map(normalize));
    pending.catch(() => routeVectors.delete(key));
    routeVectors.set(key, pending);
  }
  return pending;
}

function ranks(scores: number[]): number[] {
  const order = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
  const rank = new Array<number>(scores.length);
  order.forEach(([, i], r) => (rank[i] = r));
  return rank;
}

/**
 * Pick the `limit` routes worth showing Clef.
 *
 * `lexical` matches spelling only, so it finds typos but misses synonyms
 * (`/jobs` vs `/careers`). `hybrid` also ranks routes by embedding similarity
 * and fuses both rankings. Sites with no more than `limit` routes skip this
 * entirely: every route goes to Clef.
 */
export async function shortlist(
  ai: AiLike,
  manifest: Manifest,
  path: string,
  limit: number,
  opts: Pick<ResolveOptions, "shortlist" | "embeddingModel"> = {},
): Promise<RouteEntry[]> {
  const routes = manifest.routes;
  if (routes.length <= limit) return routes;

  const lexical = routes.map((r) => lexicalScore(path, r));
  const mode = opts.shortlist ?? "hybrid";
  let fused = lexical;

  if (mode === "hybrid") {
    const model = opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    try {
      const [vectors, [query]] = await Promise.all([
        vectorsFor(ai, manifest, model),
        embed(ai, model, [QUERY_PREFIX + humanizePath(path)]),
      ]);
      const q = normalize(query!);
      const lexRank = ranks(lexical);
      const semRank = ranks(vectors.map((v) => dot(v, q)));
      fused = routes.map((_, i) => 1 / (RRF_K + lexRank[i]!) + 1 / (RRF_K + semRank[i]!));
    } catch (err) {
      // Embeddings are an optimization; spelling-only still works.
      console.error("route-yes: embedding shortlist failed, using lexical", err);
    }
  }

  return fused
    .map((score, i) => ({ score, route: routes[i]! }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.route);
}
