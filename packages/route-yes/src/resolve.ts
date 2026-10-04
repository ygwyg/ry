import { findNormalizedMatch, findTypoMatch, skipReason } from "./match.js";
import { humanizePath, shortlist } from "./shortlist.js";
import type {
  AiLike,
  ClefModel,
  Decision,
  Manifest,
  ResolveOptions,
  RouteEntry,
  RouteRequest,
  Suggestion,
} from "./types.js";

/** Choice option id meaning "none of these pages". Paths start with `/`, so it can't collide. */
export const NONE = "none";

const DEFAULTS = {
  model: "clef-flash",
  minConfidence: 0.7,
  minDominantConfidence: 0.5,
  dominance: 3,
  minHumanLikelihood: 0.5,
  maxCandidates: 60,
  maxSuggestions: 3,
  rerankSize: 5,
} as const;

/** Build the Clef request body for a missing path. Exported for testing and debugging. */
export function buildClefInput(
  req: RouteRequest,
  candidates: RouteEntry[],
  opts: ResolveOptions = {},
) {
  const criteria: Record<string, string | null> = {};
  // Pages often share generic titles ("Pricing", "Limits"). Name the section
  // each one lives in so Clef can tell them apart.
  const titleCounts = new Map<string, number>();
  for (const r of candidates) {
    if (r.title) titleCounts.set(r.title, (titleCounts.get(r.title) ?? 0) + 1);
  }
  for (const r of candidates) {
    let title = r.title;
    if (title && opts.disambiguateTitles !== false && titleCounts.get(title)! > 1) {
      const section = humanizePath(r.path.replace(/\/+$/, "").split("/").slice(0, -1).join("/"));
      if (section) title = `${title} (${section})`;
    }
    const text = [title, r.description].filter(Boolean).join(" — ");
    criteria[r.path] = text || null;
  }
  criteria[NONE] =
    "None of these pages is a plausible match for what the visitor wanted";

  const state: Record<string, string> = {
    situation:
      "A visitor requested a URL on this website that does not exist (HTTP 404).",
    requested_url: req.path + (req.search ?? ""),
  };
  if (req.referrer) state.referrer = req.referrer;
  if (opts.siteDescription) state.site = opts.siteDescription;

  return {
    model: opts.model ?? DEFAULTS.model,
    state,
    questions: {
      destination: {
        type: "choice",
        instructions:
          "Which existing page was the visitor most likely trying to reach? Consider typos, renamed or moved pages, old links, plurals, synonyms, and guessed URLs. Choose 'none' when no page plausibly matches; do not guess the homepage just because nothing else fits.",
        criteria,
      },
      human: {
        type: "noul",
        instructions:
          "Does this look like a person trying to reach real content on the site?",
        criteria: {
          true: "A typo, an outdated or mangled link, or a guessed URL for real content",
          false:
            "An automated probe for admin panels, credentials, config files, exploits, or random garbage",
        },
      },
    },
  };
}

interface ClefChoice {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

interface ClefOutput {
  answers: { destination?: ClefChoice; human?: { noul: number } };
  usage?: Usage;
}

type Usage = { input_tokens: number; output_tokens: number };

type Judged = Pick<Decision, "kind" | "to" | "confidence" | "humanLikelihood" | "suggestions" | "reason" | "rounds"> & {
  ranked: [string, number][];
};

function addUsage(a?: Usage, b?: Usage): Usage | undefined {
  if (!a || !b) return a ?? b;
  return { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens };
}

function unwrap(raw: unknown): ClefOutput {
  // env.AI.run returns the output directly; the REST API wraps it in `result`.
  const out = (raw as { result?: unknown })?.result ?? raw;
  if (!out || typeof out !== "object" || !("answers" in out)) {
    throw new Error(`route-yes: unexpected Clef response: ${JSON.stringify(raw)}`);
  }
  return out as ClefOutput;
}

function withSearch(path: string, search?: string) {
  return search && search !== "?" ? path + search : path;
}

/** The route's Markdown version if this request asked for one and one exists, else the page. */
function pathFor(route: RouteEntry, req: RouteRequest) {
  return req.markdown && route.markdown ? route.markdown : route.path;
}

function targetOf(route: RouteEntry, req: RouteRequest) {
  return withSearch(pathFor(route, req), req.search);
}

/**
 * Decide where a request for a missing path should go.
 *
 * Runs a free normalization check first, then a cheap lexical prefilter, and
 * only then asks Clef to pick among the remaining candidates.
 */
export async function resolveRoute(
  ai: AiLike,
  manifest: Manifest,
  req: RouteRequest,
  opts: ResolveOptions = {},
): Promise<Decision> {
  const base = { from: req.path, confidence: 0, suggestions: [] as Suggestion[] };
  // A Markdown-only route has no page a browser could land on.
  if (!req.markdown && manifest.routes.some((r) => r.markdownOnly)) {
    // Its own version, since the shortlist caches route embeddings per version.
    manifest = {
      ...manifest,
      version: `${manifest.version}:html`,
      routes: manifest.routes.filter((r) => !r.markdownOnly),
    };
  }
  const routes = manifest.routes;

  if (routes.some((r) => r.path === req.path || r.markdown === req.path)) {
    // The route exists but still 404'd: stale manifest. Never redirect to itself.
    return { ...base, kind: "skip", reason: "path is in manifest" };
  }

  const exact = findNormalizedMatch(req.path, routes);
  if (exact) {
    return {
      ...base,
      kind: "normalized",
      to: targetOf(exact, req),
      confidence: 1,
    };
  }

  const skip = skipReason(req.path);
  if (skip) return { ...base, kind: "skip", reason: skip };

  if (opts.typoFix !== false) {
    const typo = findTypoMatch(req.path, routes);
    if (typo) {
      return { ...base, kind: "typo", to: targetOf(typo, req), confidence: 1 };
    }
  }
  if (routes.length === 0) return { ...base, kind: "skip", reason: "no routes" };

  const limit = Math.min(opts.maxCandidates ?? DEFAULTS.maxCandidates, 254);
  const candidates = await shortlist(ai, manifest, req.path, limit, opts);
  opts.onShortlist?.(candidates);

  const model = (opts.model ?? DEFAULTS.model) as ClefModel;
  const ask = async (routesToAsk: RouteEntry[]) => {
    const out = unwrap(await ai.run(`@cf/cloudflare/${model}`, buildClefInput(req, routesToAsk, opts)));
    if (!out.answers.destination) throw new Error("route-yes: Clef returned no destination answer");
    return out;
  };

  const first = await ask(candidates);
  const human = first.answers.human?.noul ?? 1;
  let usage = first.usage;
  let decision = judge(first.answers.destination!, human, candidates);

  // With many options Clef's probability spreads thin even when its ranking
  // is right. If it's unsure, ask again with just its top few.
  const rerankSize = opts.rerank === false ? 0 : (opts.rerankSize ?? DEFAULTS.rerankSize);
  if (decision.reason === "low confidence" && rerankSize >= 2 && decision.ranked.length >= 2) {
    const byPath = new Map(candidates.map((r) => [r.path, r]));
    const top = decision.ranked.slice(0, rerankSize).map(([path]) => byPath.get(path)!);
    const second = await ask(top);
    usage = addUsage(usage, second.usage);
    decision = judge(second.answers.destination!, human, top, decision.suggestions);
    decision.rounds = 2;
  }

  const { ranked: _ranked, ...result } = decision;
  return {
    ...base,
    ...result,
    to: result.to && withSearch(result.to, req.search),
    model,
    usage,
  };

  function judge(
    dest: ClefChoice,
    humanLikelihood: number,
    asked: RouteEntry[],
    fallbackSuggestions?: Suggestion[],
  ): Judged {
    const byPath = new Map(asked.map((r) => [r.path, r]));
    const ranked = Object.entries(dest.probabilities)
      .filter(([id]) => id !== NONE && byPath.has(id))
      .sort((a, b) => b[1] - a[1]);

    const minHuman = opts.minHumanLikelihood ?? DEFAULTS.minHumanLikelihood;
    let suggestions: Suggestion[] =
      humanLikelihood < minHuman
        ? []
        : ranked
            .filter(([, p]) => p >= 0.1)
            .slice(0, opts.maxSuggestions ?? DEFAULTS.maxSuggestions)
            .map(([path, probability]) => {
              const route = byPath.get(path)!;
              return { path: pathFor(route, req), title: route.title, probability };
            });
    if (suggestions.length === 0 && fallbackSuggestions) suggestions = fallbackSuggestions;

    const confidence = dest.probabilities[dest.choice] ?? 0;
    const common = { humanLikelihood, suggestions, confidence, ranked };

    if (humanLikelihood < minHuman) {
      return { ...common, kind: "miss", reason: "not a person looking for content" };
    }
    if (dest.choice === NONE || !byPath.has(dest.choice)) {
      return { ...common, kind: "miss", reason: "no plausible match" };
    }
    // Confident outright, or a clear winner over the next-best page (the rest
    // of the probability is on "none", not a rival route).
    const runnerUp = ranked[1]?.[1] ?? 0;
    const dominant =
      confidence >= (opts.minDominantConfidence ?? DEFAULTS.minDominantConfidence) &&
      confidence >= (opts.dominance ?? DEFAULTS.dominance) * runnerUp;
    if (confidence < (opts.minConfidence ?? DEFAULTS.minConfidence) && !dominant) {
      return { ...common, kind: "miss", reason: "low confidence" };
    }
    return { ...common, kind: "ai", to: pathFor(byPath.get(dest.choice)!, req) };
  }
}
