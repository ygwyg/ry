import type { Decision } from "./types.js";

export type { Decision, Suggestion } from "./types.js";

export interface ClientOptions {
  /** Must match the Worker's `endpoint` option. Default `/_route-yes`. */
  endpoint?: string;
  signal?: AbortSignal;
}

/**
 * Ask the Worker where a missing path should go. For SPAs, where unknown
 * URLs are served `index.html` and the 404 happens in the browser.
 */
export async function resolveRoute(
  path: string = typeof location !== "undefined" ? location.pathname : "/",
  options: ClientOptions = {},
): Promise<Decision | null> {
  const endpoint = options.endpoint ?? "/_route-yes";
  try {
    const res = await fetch(`${endpoint}/resolve?path=${encodeURIComponent(path)}`, {
      signal: options.signal,
      headers: { accept: "application/json" },
    });
    return res.ok ? ((await res.json()) as Decision) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the current URL and navigate if Clef is confident. Returns the
 * decision so the not-found view can show suggestions otherwise.
 *
 * ```ts
 * // TanStack Router
 * notFoundComponent: () => {
 *   const navigate = useNavigate();
 *   useEffect(() => { routeYes({ navigate: (to) => navigate({ to, replace: true }) }) }, []);
 *   ...
 * }
 * ```
 */
export async function routeYes(
  options: ClientOptions & { navigate?: (to: string) => void; path?: string } = {},
): Promise<Decision | null> {
  const path = options.path ?? location.pathname;
  const decision = await resolveRoute(path, options);
  if (decision?.to) {
    const to = decision.to.includes("?") ? decision.to : decision.to + location.search;
    if (options.navigate) options.navigate(to + location.hash);
    else location.replace(to + location.hash);
  }
  return decision;
}
