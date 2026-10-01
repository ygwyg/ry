import type { Decision } from "./types.js";

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A minimal, self-contained "did you mean" 404 page. */
export function renderSuggestPage(decision: Decision): string {
  const items = decision.suggestions
    .map(
      (s) =>
        `<li><a href="${escape(s.path)}">${escape(s.title || s.path)}</a><span>${escape(s.path)}</span></li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #6b6b6b; --bg: #fafaf9; --line: #e5e5e3; --accent: #f38020; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ededec; --muted: #9a9a98; --bg: #141414; --line: #2a2a2a; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  main { width: min(32rem, calc(100% - 2rem)); }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  p { color: var(--muted); margin: 0 0 1.5rem; word-break: break-all; }
  code { color: var(--fg); }
  ul { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--line); }
  li { border-bottom: 1px solid var(--line); }
  a { display: block; padding: .75rem 0 0; color: var(--fg); font-weight: 600; text-decoration: none; }
  a:hover { color: var(--accent); }
  li span { display: block; padding-bottom: .75rem; color: var(--muted); font-size: .875rem; }
</style>
</head>
<body>
<main>
  <h1>That page doesn't exist</h1>
  <p>Nothing lives at <code>${escape(decision.from)}</code>. Were you looking for one of these?</p>
  <ul>${items}</ul>
</main>
</body>
</html>`;
}
