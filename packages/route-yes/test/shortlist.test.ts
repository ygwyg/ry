import { describe, expect, it, vi } from "vitest";
import { humanizePath, shortlist } from "../src/shortlist.js";
import type { AiLike, Manifest } from "../src/types.js";

// Fake embeddings: one dimension per concept, so "jobs" lands next to "careers".
const CONCEPTS = [["career", "job", "hiring"], ["price", "pricing", "cost"], ["doc", "guide"]];
function vec(text: string) {
  const t = text.toLowerCase();
  return CONCEPTS.map((words) => (words.some((w) => t.includes(w)) ? 1 : 0.01));
}

const manifest: Manifest = {
  version: "s1",
  routes: [
    { path: "/careers", title: "Careers" },
    { path: "/pricing", title: "Pricing" },
    { path: "/docs", title: "Docs" },
    { path: "/jab", title: "Jab" },
    { path: "/jobsite-safety", title: "Site safety" },
  ],
};

describe("shortlist", () => {
  it("humanizes paths", () => {
    expect(humanizePath("/workers/cron-triggers/")).toBe("workers cron triggers");
  });

  it("skips everything when the site is small", async () => {
    const ai = { run: vi.fn() };
    expect(await shortlist(ai, manifest, "/jobs", 10)).toHaveLength(5);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("keeps synonyms that spelling alone would drop", async () => {
    const ai: AiLike = {
      run: vi.fn(async (_model: string, input: { text: string[] }) => ({ data: input.text.map(vec) })),
    };
    const lexical = await shortlist(ai, manifest, "/jobs", 2, { shortlist: "lexical" });
    expect(lexical.map((r) => r.path)).not.toContain("/careers");

    const hybrid = await shortlist(ai, manifest, "/jobs", 2, { shortlist: "hybrid" });
    expect(hybrid.map((r) => r.path)).toContain("/careers");
  });

  it("falls back to lexical when embeddings fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ai: AiLike = { run: async () => { throw new Error("down"); } };
    const out = await shortlist(ai, { ...manifest, version: "s2" }, "/pricng", 1);
    expect(out[0]!.path).toBe("/pricing");
  });
});
