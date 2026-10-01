import { withRouteYes } from "route-yes/worker";

// The Worker only runs when no static asset matches, so every request here is
// a would-be 404. route-yes serves it from ASSETS and reroutes if it can.
const router = withRouteYes(undefined, {
  siteDescription: "Acme Cloud, a developer platform for deploying apps",
  onDecision: (d) => console.log(`[route-yes] ${d.from} → ${d.to ?? "(404)"} ${d.kind} ${d.confidence.toFixed(2)}`),
});

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: { waitUntil(promise: Promise<unknown>): void }) {
    const res = await router.fetch(request, env, ctx);
    const info = res.headers.get("x-route-yes");
    if (!info || res.status < 300 || res.status >= 400) return res;

    // Demo only: hand the decision to the next page so it can show a banner.
    const out = new Response(res.body, res);
    const value = encodeURIComponent(JSON.stringify({ from: new URL(request.url).pathname, info }));
    out.headers.append("set-cookie", `ry=${value}; Path=/; Max-Age=30; SameSite=Lax`);
    return out;
  },
};
