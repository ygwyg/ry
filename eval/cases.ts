// Labeled 404s for the cf-docs fixture. `targets` lists every acceptable
// destination; an empty list means the right answer is not to redirect.
import type { Manifest } from "route-yes";

export type Category = "typo" | "synonym" | "moved" | "no-match" | "bot";
export interface Case {
  path: string;
  category: Category;
  targets: string[];
}

const synonym = (path: string, ...targets: string[]): Case => ({ path, category: "synonym", targets });
const moved = (path: string, ...targets: string[]): Case => ({ path, category: "moved", targets });

const HAND_WRITTEN: Case[] = [
  // Different words for the same page.
  synonym("/workers/cost", "/workers/platform/pricing/"),
  synonym("/kv/quotas", "/kv/platform/limits/"),
  synonym("/d1/backup-restore", "/d1/reference/time-travel/", "/d1/reference/backups/"),
  synonym("/workers/env-vars", "/workers/configuration/environment-variables/", "/workers/development-testing/environment-variables/"),
  synonym("/workers/cron-jobs", "/workers/configuration/cron-triggers/", "/workers/runtime-apis/handlers/scheduled/"),
  synonym("/workers/custom-domain", "/workers/configuration/routing/custom-domains/", "/workers/configuration/routing/"),
  synonym("/queues/dlq", "/queues/configuration/dead-letter-queues/"),
  synonym("/queues/retries", "/queues/configuration/batching-retries/"),
  synonym("/r2/s3-compatibility", "/r2/api/s3/", "/r2/api/s3/api/"),
  synonym("/r2/signed-urls", "/r2/api/s3/presigned-urls/"),
  synonym("/r2/chunked-upload", "/r2/objects/multipart-objects/"),
  synonym("/r2/migrate-from-s3", "/r2/data-migration/", "/r2/data-migration/super-slurper/", "/r2/data-migration/sippy/", "/r2/data-migration/migration-strategies/"),
  synonym("/durable-objects/websocket-server", "/durable-objects/best-practices/websockets/", "/durable-objects/examples/websocket-server/"),
  synonym("/durable-objects/sql", "/durable-objects/api/sqlite-storage-api/"),
  synonym("/durable-objects/timers", "/durable-objects/api/alarms/"),
  synonym("/workers-ai/openai", "/workers-ai/configuration/open-ai-compatibility/"),
  synonym("/workers-ai/tool-use", "/workers-ai/features/function-calling/"),
  synonym("/workers-ai/structured-output", "/workers-ai/features/json-mode/"),
  synonym("/workers-ai/catalog", "/workers-ai/models/"),
  synonym("/workers-ai/lora-adapters", "/workers-ai/features/fine-tunes/loras/", "/workers-ai/features/fine-tunes/", "/workers-ai/features/fine-tunes/public-loras/"),
  synonym("/workers/python-support", "/workers/languages/python/"),
  synonym("/workers/node-compat", "/workers/runtime-apis/nodejs/"),
  synonym("/workers/hashing", "/workers/runtime-apis/web-crypto/"),
  synonym("/workers/raw-sockets", "/workers/runtime-apis/tcp-sockets/"),
  synonym("/workers/logging", "/workers/observability/logs/", "/workers/observability/logs/workers-logs/"),
  synonym("/workers/github-actions", "/workers/ci-cd/external-cicd/github-actions/"),
  synonym("/workers/terraform", "/workers/platform/infrastructure-as-code/"),
  synonym("/d1/indexes", "/d1/best-practices/use-indexes/"),
  synonym("/d1/read-replicas", "/d1/best-practices/read-replication/"),
  synonym("/kv/remove-key", "/kv/api/delete-key-value-pairs/"),
  synonym("/kv/eventual-consistency", "/kv/concepts/how-kv-works/"),
  synonym("/r2/cors-policy", "/r2/buckets/cors/"),
  synonym("/r2/public-access", "/r2/buckets/public-buckets/"),
  synonym("/workers/spa-fallback", "/workers/static-assets/routing/single-page-application/"),
  synonym("/workers/html-rewriting", "/workers/runtime-apis/html-rewriter/"),
  synonym("/workers/rate-limiting", "/workers/runtime-apis/bindings/rate-limit/"),
  synonym("/workers/unit-tests", "/workers/testing/", "/workers/testing/vitest-integration/"),

  // Old URLs from an earlier docs structure.
  moved("/workers/platform/environment-variables/", "/workers/configuration/environment-variables/"),
  moved("/workers/learning/how-workers-works/", "/workers/reference/how-workers-works/"),
  moved("/workers/platform/compatibility-dates/", "/workers/configuration/compatibility-dates/"),
  moved("/workers/platform/cron-triggers/", "/workers/configuration/cron-triggers/"),
  moved("/r2/data-access/s3-api/", "/r2/api/s3/", "/r2/api/s3/api/"),
  moved("/r2/platform/pricing/", "/r2/pricing/"),
  moved("/d1/platform/wrangler-commands/", "/d1/wrangler-commands/"),
  moved("/queues/platform/javascript-apis/", "/queues/configuration/javascript-apis/"),
  moved("/workers/runtime-apis/kv/", "/kv/api/", "/kv/"),
  moved("/workers/runtime-apis/durable-objects/", "/durable-objects/api/", "/durable-objects/"),
  moved("/workers/learning/security-model/", "/workers/reference/security-model/"),
  moved("/workers/platform/sites/", "/workers/configuration/sites/"),
  moved("/r2/buckets/cors-configuration/", "/r2/buckets/cors/"),
  moved("/workers/runtime-apis/html-rewriter/content-types/", "/workers/runtime-apis/html-rewriter/"),
  moved("/d1/build-with-d1/foreign-keys/", "/d1/sql-api/foreign-keys/"),

  // Plausible URLs with no matching page: ry should not redirect.
  ...[
    "/careers", "/blog/2023/holiday-party", "/workers/kubernetes-operator", "/r2/ftp-server",
    "/d1/mongodb-driver", "/about-our-ceo", "/workers/minecraft-server", "/kv/graphql-subscriptions",
    "/partners/reseller-program", "/workers-ai/image-to-3d-printing", "/press-kit", "/status-page",
  ].map((path): Case => ({ path, category: "no-match", targets: [] })),

  // Scanner traffic that the static skip rules don't catch.
  ...["/admin", "/administrator/index", "/api/v1/users", "/login", "/phpinfo", "/server-info", "/backup", "/old-site/admin", "/console", "/debug/vars"]
    .map((path): Case => ({ path, category: "bot", targets: [] })),
];

// Deterministic PRNG so the typo set is stable between runs.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
}

function mutate(word: string, rand: () => number): string {
  const i = 1 + Math.floor(rand() * (word.length - 2));
  const kind = Math.floor(rand() * 3);
  if (kind === 0) return word.slice(0, i) + word.slice(i + 1); // drop a letter
  if (kind === 1) return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2); // swap
  const letters = "abcdefghijklmnopqrstuvwxyz";
  return word.slice(0, i) + letters[Math.floor(rand() * 26)] + word.slice(i + 1); // replace
}

/** One typo in the last path segment of 40 random pages. */
export function typoCases(manifest: Manifest, count = 40, seed = 7): Case[] {
  const rand = rng(seed);
  const pool = manifest.routes.filter((r) => {
    const last = r.path.split("/").filter(Boolean).pop() ?? "";
    return last.length >= 6;
  });
  const out: Case[] = [];
  const known = new Set(manifest.routes.map((r) => r.path));
  while (out.length < count) {
    const r = pool[Math.floor(rand() * pool.length)]!;
    const parts = r.path.split("/");
    const idx = parts.length - 2;
    parts[idx] = mutate(parts[idx]!, rand);
    const path = parts.join("/");
    if (known.has(path) || out.some((c) => c.path === path)) continue;
    out.push({ path, category: "typo", targets: [r.path] });
  }
  return out;
}

export function allCases(manifest: Manifest): Case[] {
  const known = new Set(manifest.routes.map((r) => r.path));
  for (const c of HAND_WRITTEN) {
    for (const t of c.targets) if (!known.has(t)) throw new Error(`case ${c.path}: unknown target ${t}`);
    if (known.has(c.path)) throw new Error(`case ${c.path} exists in the manifest`);
  }
  return [...typoCases(manifest), ...HAND_WRITTEN];
}
