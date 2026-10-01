import { describe, expect, it, vi } from "vitest";
import { findNormalizedMatch, normalizePath, prefilter, skipReason } from "../src/match.js";
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
    const d = await resolveRoute(ai, manifest, { path: "/abuot" });
    expect(d).toMatchObject({ kind: "ai", to: "/about", confidence: 0.92 });

    const [model, input] = ai.run.mock.calls[0]!;
    expect(model).toBe("@cf/cloudflare/clef-flash");
    expect(input.model).toBe("clef-flash");
    expect(input.questions.destination.criteria["/about"]).toBe("About us — The team behind Acme");
    expect(input.questions.destination.criteria[NONE]).toBeTruthy();
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
    expect(await resolveRoute(ai, manifest, { path: "/pricng" })).toMatchObject({ kind: "ai", to: "/pricing" });
    const close = fakeAi({ "/pricing": 0.55, "/about": 0.3, [NONE]: 0.15 });
    expect((await resolveRoute(close, manifest, { path: "/x" })).kind).toBe("miss");
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

    const clef = fakeAi({ "/pricing": 0.9, [NONE]: 0.1 });
    expect(await resolveRoute(clef, withTwin, { path: "/priceing", markdown: true }))
      .toMatchObject({ kind: "ai", to: "/pricing.md" });
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
