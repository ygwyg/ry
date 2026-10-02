import { describe, expect, it, vi } from "vitest";
import { findNormalizedMatch, findTypoMatch, normalizePath, prefilter, skipReason, typoDistance } from "../src/match.js";
import { NONE, resolveRoute } from "../src/resolve.js";
import type { AiLike, Manifest } from "../src/types.js";

const manifest: Manifest = {
  version: "test",
  routes: [
    { path: "/", title: "Home" },
    { path: "/about", title: "About us", description: "The team behind Acme" },
    { path: "/pricing", title: "Pricing", description: "Plans and billing" },
    { path: "/blog/hello-world", title: "Hello, world" },
    { path: "/docs/getting-started", title: "Getting started" },
  ],
};

function fakeAi(probabilities: Record<string, number>, human = 0.95): AiLike & { run: ReturnType<typeof vi.fn> } {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? NONE;
  return {
    run: vi.fn(async () => ({
      model: "clef-flash",
      answers: {
        destination: { type: "choice", choice, probabilities, confidence: 0.9 },
        human: { type: "noul", noul: human },
      },
      usage: { input_tokens: 300, output_tokens: 0 },
    })),
  };
}

describe("normalizePath", () => {
  it.each([
    ["/About/", "/about"],
    ["/about.html", "/about"],
    ["//docs//getting-started/", "/docs/getting-started"],
    ["/blog/index.html", "/blog"],
    ["/About.md", "/about"],
    ["/docs/index.md", "/docs"],
    ["/%41bout", "/about"],
    ["/", "/"],
  ])("%s → %s", (input, out) => expect(normalizePath(input)).toBe(out));
});

describe("skipReason", () => {
  it("skips probes and assets", () => {
    expect(skipReason("/wp-admin/install.php")).toBeTruthy();
    expect(skipReason("/.env")).toBeTruthy();
    expect(skipReason("/assets/app.js")).toBeTruthy();
    expect(skipReason("/abuot")).toBeUndefined();
  });

  it("skips repository files scanners probe for", () => {
    expect(skipReason("/README.md")).toBe("repository file");
    expect(skipReason("/vendor/acme/CHANGELOG.md")).toBe("repository file");
    expect(skipReason("/LICENSE.md")).toBe("repository file");
    expect(skipReason("/readme-first.md")).toBeUndefined();
    expect(skipReason("/changelog")).toBeUndefined();
  });
});

describe("prefilter", () => {
  it("keeps the most plausible routes", () => {
    const top = prefilter("/pricng", manifest.routes, 2).map((r) => r.path);
    expect(top[0]).toBe("/pricing");
  });
  it("matches on title words", () => {
    const top = prefilter("/getting-started", manifest.routes, 1).map((r) => r.path);
    expect(top).toEqual(["/docs/getting-started"]);
  });
});

describe("resolveRoute", () => {
  it("redirects normalized matches without calling Clef", async () => {
    const ai = fakeAi({});
    const d = await resolveRoute(ai, manifest, { path: "/About/", search: "?ref=x" });
    expect(d).toMatchObject({ kind: "normalized", to: "/about?ref=x", confidence: 1 });
    expect(ai.run).not.toHaveBeenCalled();
    expect(findNormalizedMatch("/nope", manifest.routes)).toBeUndefined();
  });

  it("follows a confident Clef choice", async () => {
    const ai = fakeAi({ "/about": 0.92, "/pricing": 0.03, [NONE]: 0.05 });
    const d = await resolveRoute(ai, manifest, { path: "/company-story" });
    expect(d).toMatchObject({ kind: "ai", to: "/about", confidence: 0.92 });

    const [model, input] = ai.run.mock.calls[0]!;
    expect(model).toBe("@cf/cloudflare/clef-flash");
    expect(input.model).toBe("clef-flash");
    expect(input.questions.destination.criteria["/about"]).toBe("About us — The team behind Acme");
    expect(input.questions.destination.criteria[NONE]).toBeTruthy();
  });

  it("disambiguates pages that share a title", async () => {
    const ai = fakeAi({ "/workers/pricing": 0.9, [NONE]: 0.1 });
    const shared: Manifest = {
      version: "dup",
      routes: [
        { path: "/workers/pricing", title: "Pricing" },
        { path: "/r2/platform/pricing/", title: "Pricing" },
        { path: "/about", title: "About" },
      ],
    };
    await resolveRoute(ai, shared, { path: "/workers/cost" });
    const criteria = ai.run.mock.calls[0]![1].questions.destination.criteria;
    expect(criteria["/workers/pricing"]).toBe("Pricing (workers)");
    expect(criteria["/r2/platform/pricing/"]).toBe("Pricing (r2 platform)");
    expect(criteria["/about"]).toBe("About");
  });

  it("misses with suggestions when unsure", async () => {
    const ai = fakeAi({ "/about": 0.4, "/pricing": 0.35, [NONE]: 0.25 });
    const d = await resolveRoute(ai, manifest, { path: "/company" });
    expect(d.kind).toBe("miss");
    expect(d.to).toBeUndefined();
    expect(d.suggestions.map((s) => s.path)).toEqual(["/about", "/pricing"]);
  });

  it("redirects a clear winner below minConfidence", async () => {
    const ai = fakeAi({ "/pricing": 0.6, "/about": 0.1, [NONE]: 0.3 });
    expect(await resolveRoute(ai, manifest, { path: "/plans" })).toMatchObject({ kind: "ai", to: "/pricing" });
    const close = fakeAi({ "/pricing": 0.55, "/about": 0.3, [NONE]: 0.15 });
    expect((await resolveRoute(close, manifest, { path: "/x" })).kind).toBe("miss");
  });

  it("fixes obvious typos without calling Clef", async () => {
    const ai = fakeAi({});
    expect(await resolveRoute(ai, manifest, { path: "/abuot", search: "?a=1" })).toMatchObject({
      kind: "typo",
      to: "/about?a=1",
    });
    expect(await resolveRoute(ai, manifest, { path: "/blog/helo-world" })).toMatchObject({ to: "/blog/hello-world" });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("leaves ambiguous or short typos to Clef", async () => {
    const posts: Manifest = { version: "p", routes: [{ path: "/post-1" }, { path: "/post-2" }] };
    expect(findTypoMatch("/post-3", posts.routes)).toBeUndefined();
    expect(findTypoMatch("/abt", manifest.routes)).toBeUndefined();
    expect(findTypoMatch("/aboot", manifest.routes, )?.path).toBe("/about");
    expect(typoDistance("pricnig", "pricing")).toBe(1);
  });

  it("asks a second, narrower question when unsure", async () => {
    const answers = [
      { "/about": 0.35, "/pricing": 0.2, "/docs/getting-started": 0.1, [NONE]: 0.35 },
      { "/about": 0.8, "/pricing": 0.1, [NONE]: 0.1 },
    ];
    const run = vi.fn(async (_m: string, input: { questions: { destination: { criteria: object } } }) => {
      const probabilities = answers.shift()!;
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
      return {
        answers: { destination: { choice, probabilities, confidence: 0.5 }, human: { noul: 0.9 } },
        usage: { input_tokens: Object.keys(input.questions.destination.criteria).length * 10, output_tokens: 0 },
      };
    });
    const d = await resolveRoute({ run }, manifest, { path: "/team-page" }, { rerankSize: 3 });
    expect(d).toMatchObject({ kind: "ai", to: "/about", rounds: 2, confidence: 0.8 });
    expect(Object.keys(run.mock.calls[1]![1].questions.destination.criteria)).toEqual([
      "/about", "/pricing", "/docs/getting-started", NONE,
    ]);
    expect(d.usage).toEqual({ input_tokens: 60 + 40, output_tokens: 0 });

    const once = await resolveRoute(fakeAi({ "/about": 0.35, "/pricing": 0.2, [NONE]: 0.45 }), manifest, { path: "/x-y" }, { rerank: false });
    expect(once.rounds).toBeUndefined();
  });

  it("misses when Clef says none", async () => {
    const d = await resolveRoute(fakeAi({ "/about": 0.1, [NONE]: 0.9 }), manifest, { path: "/zzz" });
    expect(d).toMatchObject({ kind: "miss", reason: "no plausible match" });
  });

  it("never redirects bots", async () => {
    const d = await resolveRoute(fakeAi({ "/about": 0.95, [NONE]: 0.05 }, 0.1), manifest, {
      path: "/admin-backup",
    });
    expect(d).toMatchObject({ kind: "miss", suggestions: [] });
  });

  it("ignores options Clef invents", async () => {
    const d = await resolveRoute(fakeAi({ "/evil": 0.99, [NONE]: 0.01 }), manifest, { path: "/x" });
    expect(d.kind).toBe("miss");
  });

  it("skips paths that are already in the manifest", async () => {
    const ai = fakeAi({});
    const d = await resolveRoute(ai, manifest, { path: "/about" });
    expect(d.kind).toBe("skip");
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("sends a Markdown request to the page's Markdown version", async () => {
    const withTwin: Manifest = {
      version: "md",
      routes: [
        { path: "/pricing", title: "Pricing", markdown: "/pricing.md" },
        { path: "/about", title: "About" },
      ],
    };
    const ai = fakeAi({});
    expect(await resolveRoute(ai, withTwin, { path: "/Pricing.md", markdown: true }))
      .toMatchObject({ kind: "normalized", to: "/pricing.md" });
    // No twin: the page itself is still the right answer.
    expect(await resolveRoute(ai, withTwin, { path: "/About.md", markdown: true }))
      .toMatchObject({ kind: "normalized", to: "/about" });
    // A browser asking for the same misspelling gets the HTML page.
    expect(await resolveRoute(ai, withTwin, { path: "/Pricing/" }))
      .toMatchObject({ kind: "normalized", to: "/pricing" });
    expect(ai.run).not.toHaveBeenCalled();

    // The typo fix and Clef land on the twin too.
    expect(await resolveRoute(ai, withTwin, { path: "/priceing", markdown: true }))
      .toMatchObject({ kind: "typo", to: "/pricing.md" });
    const clef = fakeAi({ "/pricing": 0.9, [NONE]: 0.1 });
    expect(await resolveRoute(clef, withTwin, { path: "/plans", markdown: true, search: "?ref=x" }))
      .toMatchObject({ kind: "ai", to: "/pricing.md?ref=x" });
  });

  it("still sends a repository file to a real page of the same name", async () => {
    const ai = fakeAi({});
    const site: Manifest = { version: "changelog", routes: [{ path: "/changelog", title: "Changelog" }] };
    expect(await resolveRoute(ai, site, { path: "/CHANGELOG.md", markdown: true }))
      .toMatchObject({ kind: "normalized", to: "/changelog" });
    expect(await resolveRoute(ai, site, { path: "/README.md", markdown: true }))
      .toMatchObject({ kind: "skip", reason: "repository file" });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("only sends Markdown requests to a Markdown-only route", async () => {
    const site: Manifest = {
      version: "md-only",
      routes: [
        { path: "/docs/agents", title: "Agent guide", markdown: "/docs/agents.md", markdownOnly: true },
        { path: "/docs/api", title: "API reference" },
      ],
    };
    const ai = fakeAi({});
    expect(await resolveRoute(ai, site, { path: "/docs/agent", markdown: true }))
      .toMatchObject({ kind: "typo", to: "/docs/agents.md" });
    expect(await resolveRoute(ai, site, { path: "/Docs/Agents/", markdown: true }))
      .toMatchObject({ kind: "normalized", to: "/docs/agents.md" });
    expect(ai.run).not.toHaveBeenCalled();

    // A browser is never redirected there, and Clef is never offered it.
    const clef = fakeAi({ "/docs/api": 0.05, [NONE]: 0.95 });
    const d = await resolveRoute(clef, site, { path: "/docs/agents" });
    expect(d).toMatchObject({ kind: "miss" });
    expect(d.to).toBeUndefined();
    const criteria = clef.run.mock.calls[0]![1].questions.destination.criteria;
    expect(Object.keys(criteria)).toEqual(["/docs/api", NONE]);
  });

  it("suggests Markdown versions to a Markdown request", async () => {
    const site: Manifest = {
      version: "md-suggest",
      routes: [
        { path: "/about", title: "About" },
        { path: "/pricing", title: "Pricing", markdown: "/pricing.md" },
      ],
    };
    const clef = () => fakeAi({ "/about": 0.4, "/pricing": 0.35, [NONE]: 0.25 });
    const md = await resolveRoute(clef(), site, { path: "/company", markdown: true });
    expect(md.suggestions.map((s) => s.path)).toEqual(["/about", "/pricing.md"]);
    const html = await resolveRoute(clef(), site, { path: "/company" });
    expect(html.suggestions.map((s) => s.path)).toEqual(["/about", "/pricing"]);
  });

  it("skips a Markdown version that is in the manifest but 404'd", async () => {
    const ai = fakeAi({});
    const d = await resolveRoute(ai, { version: "md", routes: [{ path: "/pricing", markdown: "/pricing.md" }] }, {
      path: "/pricing.md",
      markdown: true,
    });
    expect(d).toMatchObject({ kind: "skip", reason: "path is in manifest" });
  });

  it("unwraps REST-style responses", async () => {
    const ai: AiLike = {
      run: async () => ({
        result: {
          answers: {
            destination: { choice: "/pricing", probabilities: { "/pricing": 0.8, [NONE]: 0.2 }, confidence: 0.8 },
            human: { noul: 0.9 },
          },
        },
      }),
    };
    expect((await resolveRoute(ai, manifest, { path: "/plans" })).to).toBe("/pricing");
  });
});
