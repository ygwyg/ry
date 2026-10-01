import type { AiLike } from "./types.js";

export interface RestAiOptions {
  accountId: string;
  apiToken: string;
  /** Override for testing or proxies, e.g. an AI Gateway URL. */
  baseUrl?: string;
}

/**
 * An `AiLike` that calls Workers AI over the REST API, for use outside a
 * Worker (Node dev servers, scripts, tests against the real model).
 */
export function restAi({ accountId, apiToken, baseUrl }: RestAiOptions): AiLike {
  const root = baseUrl ?? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
  return {
    async run(model: string, input: unknown) {
      const res = await fetch(`${root}/${model}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
      const body = (await res.json()) as { success?: boolean; errors?: unknown; result?: unknown };
      if (!res.ok || body.success === false) {
        throw new Error(`Workers AI ${res.status}: ${JSON.stringify(body.errors ?? body)}`);
      }
      return body.result ?? body;
    },
  };
}
