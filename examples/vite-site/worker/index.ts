import { withRouteYes, type Decision } from "route-yes/worker";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A "did you mean" page in the demo's own style. Without renderMiss,
// route-yes serves a plain built-in one.
function renderMiss(d: Decision) {
  const items = d.suggestions
    .map((s) => `<li><a href="${escape(s.path)}">${escape(s.title ?? s.path)}<small>${escape(s.path)}</small></a></li>`)
    .join("");
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Not found · clef•ai•ry</title>
<link rel="icon" href="/ry.jpeg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Pixelify+Sans:wght@400;600&display=swap">
<link rel="stylesheet" href="/demo.css">
</head>
<body>
<header class="bar"><a class="mark" href="/"><img src="/ry.jpeg" alt=""><span>clef<span class="dot">•</span>ai<span class="dot">•</span>ry</span></a></header>
<main>
  <section class="box">
    <h1 class="box-title">ry isn't sure</h1>
    <p>Nothing lives at <code>${escape(d.from)}</code>. Clef had a few ideas, but none it would bet on. Did you mean:</p>
    <ul class="menu">${items}</ul>
  </section>
</main>
</body>
</html>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

// The Worker only runs when no static asset matches, so every request here is
// a would-be 404. route-yes serves it from ASSETS and reroutes if it can.
const router = withRouteYes(undefined, {
  siteDescription: "clef•ai•ry, the website for ry, an open-source developer tool",
  renderMiss,
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
