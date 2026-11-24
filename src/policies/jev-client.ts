/** HTTP transport, retry, and strict choice-probability validation for the Jev (TypeSafe) API. */

import { sleep, toJson } from "../core/format.ts";
import { PolicyError } from "../core/types.ts";

const URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 25_000;
/** The start of Jev's error body, for the run log. */
const ERROR_CHARS = 500;

/** The subset of fetch that JevPolicy uses, so tests can answer without a network. */
export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

// biome-ignore lint/suspicious/noExplicitAny: Jev's response is validated field by field.
export type Json = any;

async function errorBody(response: Awaited<ReturnType<Fetch>>): Promise<string | null> {
  try {
    const body = await response.json();
    return (typeof body === "string" ? body : JSON.stringify(body)).slice(0, ERROR_CHARS);
  } catch {
    return null;
  }
}

export async function postJson(fetchJson: Fetch, key: string, body: unknown): Promise<Json> {
  const request = toJson(body);
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Awaited<ReturnType<Fetch>>;
    try {
      response = await fetchJson(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: request,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PolicyError("Jev connection failed; no action executed.");
    }
    if ([429, 503, 529].includes(response.status) && attempt < 2) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (response.status >= 400) {
      throw new PolicyError(`Jev returned HTTP ${response.status}; no action executed.`, {
        http_status: response.status,
        request_chars: request.length,
        error: await errorBody(response),
      });
    }
    try {
      return await response.json();
    } catch {
      throw new PolicyError("Invalid Jev response; no action executed.");
    }
  }
  throw new PolicyError("Jev unavailable; no action executed.");
}

export function validateChoice(answer: Json, ids: Iterable<string>): Json {
  const keys = new Set(ids);
  let valid = false;
  try {
    const probabilities = answer.probabilities;
    if (probabilities && typeof probabilities === "object" && !Array.isArray(probabilities)) {
      const given = Object.keys(probabilities);
      const values = Object.values(probabilities) as unknown[];
      const numbers = [...values, answer.confidence];
      const max = Math.max(...(values as number[]));
      valid =
        typeof answer.choice === "string" &&
        keys.has(answer.choice) &&
        given.length === keys.size &&
        given.every((k) => keys.has(k)) &&
        numbers.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) &&
        Math.abs((values as number[]).reduce((a, b) => a + b, 0) - 1) < 0.02 &&
        probabilities[answer.choice] >= max - 1e-6;
    }
  } catch {
    valid = false;
  }
  if (!valid) throw new PolicyError("Invalid Jev response; no action executed.");
  return answer;
}
