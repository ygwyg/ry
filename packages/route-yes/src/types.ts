/** A page that exists on the site and is a valid redirect target. */
export interface RouteEntry {
  /** Absolute path, e.g. `/blog/hello-world`. */
  path: string;
  /** Page title. Gives Clef far more to go on than the path alone. */
  title?: string;
  /** Short description, usually the page's meta description. */
  description?: string;
}

/** The set of routes route-yes is allowed to send visitors to. */
export interface Manifest {
  /** Changes whenever the routes change; used to invalidate cached decisions. */
  version: string;
  routes: RouteEntry[];
}

/**
 * Anything that can run a Workers AI model: the `env.AI` binding, or
 * `restAi()` for running outside a Worker.
 */
export interface AiLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(model: any, input: any, options?: any): Promise<any>;
}

export type ClefModel = "clef" | "clef-flash";

export interface ResolveOptions {
  /** Which Clef variant to use. `clef-flash` is roughly 5x faster. Default `clef-flash`. */
  model?: ClefModel;
  /** Probability on the chosen route that always redirects. Default `0.7`. */
  minConfidence?: number;
  /**
   * Below `minConfidence`, still redirect when the chosen route has at least
   * this probability and is `dominance` times likelier than the runner-up.
   * Default `0.5`.
   */
  minDominantConfidence?: number;
  /** See `minDominantConfidence`. Default `3`. */
  dominance?: number;
  /**
   * Minimum probability that the request is a person looking for content (as
   * opposed to a bot probing for `/wp-admin`). Default `0.5`.
   */
  minHumanLikelihood?: number;
  /** Most routes sent to Clef per request, after a cheap lexical prefilter. Max 254. Default `60`. */
  maxCandidates?: number;
  /** How many suggestions to return when nothing is confident enough. Default `3`. */
  maxSuggestions?: number;
  /** Optional one-line description of the site, which helps Clef with ambiguous paths. */
  siteDescription?: string;
}

export interface RouteRequest {
  /** The path that 404'd, e.g. `/abuot`. */
  path: string;
  /** Query string including the leading `?`, if any. Preserved on redirect. */
  search?: string;
  /** Referer header, if any. A useful hint for old inbound links. */
  referrer?: string | null;
}

export interface Suggestion {
  path: string;
  title?: string;
  probability: number;
}

export type DecisionKind =
  /** Unambiguous match after normalizing case, slashes, `.html`, and so on. No AI call. */
  | "normalized"
  /** Clef picked a route with enough confidence. */
  | "ai"
  /** Nothing confident enough. `suggestions` may still be populated. */
  | "miss"
  /** Not worth asking (assets, bot probes, non-GET, and so on). */
  | "skip";

export interface Decision {
  kind: DecisionKind;
  from: string;
  /** Redirect target, including the preserved query string. Set for `normalized` and `ai`. */
  to?: string;
  /** Probability assigned to the chosen route (1 for `normalized`). */
  confidence: number;
  /** Clef's estimate that this is a person looking for content. */
  humanLikelihood?: number;
  suggestions: Suggestion[];
  /** Why we skipped or missed, for logs. */
  reason?: string;
  model?: ClefModel;
  /** Milliseconds spent deciding (the Clef call), when not cached. */
  durationMs?: number;
  /** Whether this decision came from cache. */
  cached?: boolean;
  usage?: { input_tokens: number; output_tokens: number };
}
