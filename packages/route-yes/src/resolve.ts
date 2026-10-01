import { findNormalizedMatch, prefilter, skipReason } from "./match.js";
import type {
  AiLike,
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
  minHumanLikelihood: 0.5,
  maxCandidates: 60,
  maxSuggestions: 3,
} as const;

/** Build the Clef request body for a missing path. Exported for testing and debugging. */
export function buildClefInput(
  req: RouteRequest,
  candidates: RouteEntry[],
  opts: ResolveOptions = {},
) {
  const criteria: Record<string, string | null> = {};
  for (const r of candidates) {
    const text = [r.title, r.description].filter(Boolean).join(" — ");
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

interface ClefOutput {
  answers: {
    destination?: {
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    };
    human?: { noul: number };
  };
  usage?: { input_tokens: number; output_tokens: number };
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
  const routes = manifest.routes;

  if (routes.some((r) => r.path === req.path)) {
    // The route exists but still 404'd: stale manifest. Never redirect to itself.
    return { ...base, kind: "skip", reason: "path is in manifest" };
  }

  const exact = findNormalizedMatch(req.path, routes);
  if (exact) {
    return {
      ...base,
      kind: "normalized",
      to: withSearch(exact.path, req.search),
      confidence: 1,
    };
  }

  const skip = skipReason(req.path);
  if (skip) return { ...base, kind: "skip", reason: skip };
  if (routes.length === 0) return { ...base, kind: "skip", reason: "no routes" };

  const limit = Math.min(opts.maxCandidates ?? DEFAULTS.maxCandidates, 254);
  const candidates = prefilter(req.path, routes, limit);
  const input = buildClefInput(req, candidates, opts);
  const model = input.model as Decision["model"];
  const out = unwrap(await ai.run(`@cf/cloudflare/${model}`, input));

  const dest = out.answers.destination;
  const human = out.answers.human?.noul ?? 1;
  if (!dest) throw new Error("route-yes: Clef returned no destination answer");

  const byPath = new Map(candidates.map((r) => [r.path, r]));
  const ranked = Object.entries(dest.probabilities)
    .filter(([id]) => id !== NONE && byPath.has(id))
    .sort((a, b) => b[1] - a[1]);

  const minHuman = opts.minHumanLikelihood ?? DEFAULTS.minHumanLikelihood;
  const suggestions: Suggestion[] =
    human < minHuman
      ? []
      : ranked
          .filter(([, p]) => p >= 0.1)
          .slice(0, opts.maxSuggestions ?? DEFAULTS.maxSuggestions)
          .map(([path, probability]) => ({
            path,
            title: byPath.get(path)?.title,
            probability,
          }));

  const confidence = dest.probabilities[dest.choice] ?? 0;
  const common = { ...base, humanLikelihood: human, suggestions, model, usage: out.usage };

  if (human < minHuman) {
    return { ...common, kind: "miss", confidence, reason: "not a person looking for content" };
  }
  if (dest.choice === NONE || !byPath.has(dest.choice)) {
    return { ...common, kind: "miss", confidence, reason: "no plausible match" };
  }
  if (confidence < (opts.minConfidence ?? DEFAULTS.minConfidence)) {
    return { ...common, kind: "miss", confidence, reason: "low confidence" };
  }
  return {
    ...common,
    kind: "ai",
    to: withSearch(dest.choice, req.search),
    confidence,
  };
}
