// Runs every case against each config through the eval worker and scores it.
// Usage: pnpm dev (in another shell), then node run.ts [configName...]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Decision, Manifest, ResolveOptions } from "route-yes";
import { allCases, type Case } from "./cases.ts";

const ENDPOINT = process.env.EVAL_URL ?? "http://localhost:8798";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 6);

interface Config {
  fixture?: string;
  options: ResolveOptions;
}

const BEFORE: ResolveOptions = { typoFix: false, disambiguateTitles: false, rerank: false };

export const CONFIGS: Record<string, Config> = {
  // Round 1: how to shortlist (behavior as originally shipped otherwise).
  "lexical-60": { options: { ...BEFORE, shortlist: "lexical", maxCandidates: 60 } },
  "hybrid-60": { options: { ...BEFORE, shortlist: "hybrid", maxCandidates: 60 } },
  "lexical-254": { options: { ...BEFORE, shortlist: "lexical", maxCandidates: 254 } },
  "hybrid-120": { options: { ...BEFORE, shortlist: "hybrid", maxCandidates: 120 } },
  // Round 2: typo fast path and section names on duplicate titles.
  "hybrid-60+typo+titles": { options: { shortlist: "hybrid", maxCandidates: 60, rerank: false } },
  // Round 3: page descriptions filled from the first paragraph.
  "hybrid-60+typo+titles+paragraphs": { fixture: "cf-docs-paragraphs", options: { shortlist: "hybrid", maxCandidates: 60, rerank: false } },
  "hybrid-30+typo+titles+paragraphs": { fixture: "cf-docs-paragraphs", options: { shortlist: "hybrid", maxCandidates: 30, rerank: false } },
  // Round 4: a second, narrower Clef question when the first is unsure.
  "no-rerank": { fixture: "cf-docs-paragraphs", options: { rerank: false } },
  "rerank-5": { fixture: "cf-docs-paragraphs", options: { rerankSize: 5 } },
  "rerank-3": { fixture: "cf-docs-paragraphs", options: { rerankSize: 3 } },
  "rerank-5-no-paragraphs": { options: { rerankSize: 5 } },
};

interface Result {
  case: Case;
  decision?: Decision;
  candidates?: string[];
  shortlistMs?: number;
  clefMs?: number;
  error?: string;
}

async function runOne(c: Case, { fixture, options }: Config): Promise<Result> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, { method: "POST", body: JSON.stringify({ path: c.path, fixture, options }) });
      const body = (await res.json()) as Omit<Result, "case">;
      if (res.ok) return { case: c, ...body };
      if (attempt === 2) return { case: c, error: body.error ?? `HTTP ${res.status}` };
    } catch (err) {
      if (attempt === 2) return { case: c, error: String(err) };
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error("unreachable");
}

async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>, onDone: () => void): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
        onDone();
      }
    }),
  );
  return out;
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0;
};

export function score(results: Result[]) {
  const withTarget = results.filter((r) => r.case.targets.length > 0);
  const noTarget = results.filter((r) => r.case.targets.length === 0);
  const hit = (r: Result) => r.decision?.to !== undefined && r.case.targets.includes(r.decision.to);
  const wrong = (r: Result) => r.decision?.to !== undefined && !r.case.targets.includes(r.decision.to);
  const helpful = (r: Result) =>
    hit(r) || (!r.decision?.to && r.decision?.suggestions.some((s) => r.case.targets.includes(s.path)));
  // Typo fixes skip the shortlist; count them as found.
  const recall = (r: Result) =>
    hit(r) && !r.candidates ? true : r.candidates?.some((p) => r.case.targets.includes(p));
  const clef = results.flatMap((r) => (r.clefMs !== undefined ? [r.clefMs] : []));
  const sl = results.flatMap((r) => (r.shortlistMs !== undefined ? [r.shortlistMs] : []));
  const tokens = results.flatMap((r) => (r.decision?.usage ? [r.decision.usage.input_tokens] : []));

  return {
    "correct redirect": pct(withTarget.filter(hit).length, withTarget.length),
    "wrong redirect": pct(withTarget.filter(wrong).length, withTarget.length),
    "helped (redirect or suggested)": pct(withTarget.filter(helpful).length, withTarget.length),
    "right page shortlisted": pct(withTarget.filter(recall).length, withTarget.length),
    "redirected when it shouldn't": pct(noTarget.filter((r) => r.decision?.to).length, noTarget.length),
    "clef ms p50 / p95": `${quantile(clef, 0.5)} / ${quantile(clef, 0.95)}`,
    "shortlist ms p50": `${quantile(sl, 0.5)}`,
    "asked twice": pct(results.filter((r) => r.decision?.rounds === 2).length, results.length),
    "answered without Clef": pct(results.filter((r) => r.decision && !r.decision.usage).length, results.length),
    "input tokens avg": `${Math.round(tokens.reduce((a, b) => a + b, 0) / (tokens.length || 1))}`,
    errors: `${results.filter((r) => r.error).length}`,
  };
}

function table(rows: Record<string, Record<string, string>>) {
  const cols = Object.keys(rows);
  const metrics = Object.keys(rows[cols[0]!]!);
  const lines = [`| | ${cols.join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`];
  for (const m of metrics) lines.push(`| ${m} | ${cols.map((c) => rows[c]![m]).join(" | ")} |`);
  return lines.join("\n");
}

if (import.meta.main) {
  const manifest = JSON.parse(readFileSync("fixtures/cf-docs.json", "utf8")) as Manifest;
  const cases = allCases(manifest);
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CONFIGS);
  console.log(`${cases.length} cases × ${names.length} configs against ${manifest.routes.length} routes`);

  const all: Record<string, Result[]> = {};
  for (const name of names) {
    let done = 0;
    const started = Date.now();
    all[name] = await pool(cases, (c) => runOne(c, CONFIGS[name]!), () => {
      process.stdout.write(`\r${name}: ${++done}/${cases.length}`);
    });
    console.log(` (${Math.round((Date.now() - started) / 1000)}s)`);
  }

  mkdirSync("results", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(`results/${stamp}.json`, JSON.stringify(all, null, 1));

  console.log("\nOverall\n" + table(Object.fromEntries(names.map((n) => [n, score(all[n]!)]))));
  for (const cat of ["typo", "synonym", "moved", "no-match", "bot"] as const) {
    const rows = Object.fromEntries(names.map((n) => [n, score(all[n]!.filter((r) => r.case.category === cat))]));
    console.log(`\n${cat}\n` + table(rows));
  }
  console.log(`\nraw results: results/${stamp}.json`);
}
