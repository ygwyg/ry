import { resolveRoute, type AiLike, type Manifest, type ResolveOptions } from "route-yes";
import plain from "../fixtures/cf-docs.json";
import paragraphs from "../fixtures/cf-docs-paragraphs.json";

const FIXTURES: Record<string, Manifest> = {
  "cf-docs": plain as Manifest,
  "cf-docs-paragraphs": paragraphs as Manifest,
};

interface Body {
  path: string;
  fixture?: string;
  options: ResolveOptions;
}

export default {
  async fetch(request: Request, env: { AI: AiLike }): Promise<Response> {
    if (request.method !== "POST") return new Response("POST {path, fixture, options}", { status: 405 });
    const { path, fixture = "cf-docs", options } = (await request.json()) as Body;
    const manifest = FIXTURES[fixture];
    if (!manifest) return Response.json({ error: `unknown fixture ${fixture}` }, { status: 400 });

    try {
      const started = Date.now();
      let candidates: string[] | undefined;
      let shortlistMs: number | undefined;
      const decision = await resolveRoute(env.AI, manifest, { path }, {
        ...options,
        onShortlist: (routes) => {
          candidates = routes.map((r) => r.path);
          shortlistMs = Date.now() - started;
        },
      });
      const clefMs = shortlistMs === undefined ? undefined : Date.now() - started - shortlistMs;
      return Response.json({ decision, candidates, shortlistMs, clefMs });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  },
};
