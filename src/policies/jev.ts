/**
 * Jev's role: choose the next operation, target, and value toward Claude's goal, one page at a time.
 *
 * Adapted from jev-ultrafast (MIT); see THIRD_PARTY_LICENSE_jev-ultrafast.txt.
 */

import { Agent, fetch as undiciFetch } from "undici";
import { MATCH, NO, type Row } from "../collect.ts";
import { type Best, type Candidate, KEEP, NONE } from "../compare.ts";
import { sleep, toJson } from "../format.ts";
import {
  Decision,
  type HistoryEntry,
  type ModelCall,
  modelCall,
  type Page,
  type Plan,
  type Policy,
  PolicyError,
  type Value,
} from "../types.ts";
import { actionSpace, fileChoices, modelState, NOT_VISIBLE, resolve, valueChoices } from "./base.ts";
import {
  buildCollect,
  buildCompare,
  buildMore,
  buildQuestions,
  compareState,
  estimateTokens,
  FIT_TRIES,
  fitChoose,
  NO_VALUE,
  OVER_LIMIT,
  requestSize,
  SHRINK,
  TOKEN_BUDGET,
} from "./jev-questions.ts";

const URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 25_000;

/** The subset of fetch that JevPolicy uses, so tests can answer without a network. */
export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

// biome-ignore lint/suspicious/noExplicitAny: Jev's response is validated field by field.
type Json = any;

/** The start of Jev's error body, for the run log. */
const ERROR_CHARS = 500;

async function errorBody(response: Awaited<ReturnType<Fetch>>): Promise<string | null> {
  try {
    const body = await response.json();
    return (typeof body === "string" ? body : JSON.stringify(body)).slice(0, ERROR_CHARS);
  } catch {
    return null;
  }
}

async function postJson(fetchJson: Fetch, key: string, body: unknown): Promise<Json> {
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

export class JevPolicy implements Policy {
  name = "jev";
  calls: ModelCall[] = [];
  servedModel: string | null = null;
  readonly key: string;
  readonly model: string;
  private readonly fetchJson: Fetch;
  private readonly agent: Agent | null;
  /** Lowered for the rest of the run when Jev refuses a request over its limit. */
  private budget = TOKEN_BUDGET;

  constructor(options: { fetch?: Fetch } = {}) {
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw new PolicyError("TYPESAFE_API_KEY is not set.");
    this.key = key;
    this.model = process.env.TYPESAFE_MODEL ?? "jev-latest";
    if (options.fetch) {
      this.fetchJson = options.fetch;
      this.agent = null;
    } else {
      // HTTP/2 when the server offers it; HTTP/1.1 otherwise.
      const agent = new Agent({ allowH2: true });
      this.agent = agent;
      this.fetchJson = (url, init) => undiciFetch(url, { ...init, dispatcher: agent });
    }
  }

  config(): Record<string, unknown> {
    return { chooser: this.servedModel ?? this.model };
  }

  async close(): Promise<void> {
    await this.agent?.close();
  }

  async compare(
    page: Page,
    plan: Plan,
    criterion: string,
    best: Best | null,
    candidates: Candidate[],
  ): Promise<string> {
    const questions = buildCompare(plan, criterion, best, candidates);
    const body = { model: this.model, state: compareState(page, plan), questions };
    const result = await this.post(body, "compare");
    const keys = [...candidates.map((item) => item.key), best ? KEEP : NONE];
    return validateChoice(result?.answers?.compare ?? {}, keys).choice;
  }

  async more(page: Page, plan: Plan, control: string, candidates: Candidate[]): Promise<string> {
    // The page is in the state here: with the plan only, Jev was unsure whether the control was there (about
    // 0.5); with the page, it chose the control at 0.98 or more.
    const body = { model: this.model, state: modelState(page, [], plan), questions: buildMore(control, candidates) };
    const result = await this.post(body, "more");
    const keys = [...candidates.map((item) => item.key), NONE];
    return validateChoice(result?.answers?.more ?? {}, keys).choice;
  }

  async collect(page: Page, plan: Plan, criterion: string, rows: Row[]): Promise<Set<string>> {
    const body = { model: this.model, state: compareState(page, plan), questions: buildCollect(criterion, rows) };
    const answers = (await this.post(body, "collect")).answers ?? {};
    const keys = new Set<string>();
    for (const row of rows) {
      if (validateChoice(answers[`item_${row.key}`] ?? {}, [MATCH, NO]).choice === MATCH) keys.add(row.key);
    }
    return keys;
  }

  private async post(body: unknown, purpose: string, extra: Partial<ModelCall> = {}): Promise<Json> {
    const started = performance.now();
    const result = await postJson(this.fetchJson, this.key, body);
    const isObject = result && typeof result === "object" && !Array.isArray(result);
    const usage = (isObject && result.usage) || {};
    this.servedModel = isObject && "model" in result ? result.model : this.model;
    // The response carries token counts but no billed amount.
    this.calls.push(
      modelCall(
        "typesafe",
        this.servedModel as string,
        purpose,
        Math.round(performance.now() - started),
        "input_tokens" in usage ? usage.input_tokens : (usage.prompt_tokens ?? null),
        "output_tokens" in usage ? usage.output_tokens : (usage.completion_tokens ?? null),
      ),
    );
    Object.assign(this.calls[this.calls.length - 1], extra);
    return isObject ? result : {};
  }

  async choose(whole: Page, plan: Plan, history: HistoryEntry[]): Promise<Decision> {
    const values = valueChoices(plan);
    const files = fileChoices(plan);
    const build = (page: Page) => {
      const [, targets, controls] = actionSpace(page.actions);
      const [questions, operations] = buildQuestions(
        plan,
        targets,
        controls,
        values,
        Boolean(page.read),
        Boolean(page.tabs),
        files,
      );
      return {
        targets,
        questions,
        operations,
        body: { model: this.model, state: modelState(page, history, plan), questions },
      };
    };
    let fitted = fitChoose(whole, build, this.budget);
    let result: Json;
    const refused: NonNullable<ModelCall["refused"]> = [];
    for (let tries = 1; ; tries++) {
      const extra: Partial<ModelCall> = fitted.dropped ? { dropped_elements: fitted.dropped } : {};
      if (this.budget !== TOKEN_BUDGET) extra.token_budget = this.budget;
      if (refused.length) extra.refused = refused;
      extra.request = requestSize(fitted);
      try {
        result = await this.post(fitted.body, "choose", extra);
        break;
      } catch (error) {
        const over = error instanceof PolicyError && String(error.diagnostic?.error ?? "").includes(OVER_LIMIT);
        if (!over) throw error;
        // What Jev refused is kept in the log (counts only, no page text): its limit is not known.
        refused.push({ ...requestSize(fitted), budget: this.budget });
        if (tries >= FIT_TRIES) {
          throw new PolicyError(error.message, { ...error.diagnostic, refused });
        }
        this.budget = Math.floor(estimateTokens(toJson(fitted.body)) * SHRINK);
        fitted = fitChoose(whole, build, this.budget);
      }
    }
    const { page, targets, operations } = fitted;
    const answers = result.answers || {};
    const operationAnswer = validateChoice(answers.operation ?? {}, Object.keys(operations));
    const operation: string = operationAnswer.choice;
    const confidences: number[] = [operationAnswer.confidence];
    let target: string | null = null;
    const candidates = targets.get(operation);
    if (candidates) {
      // Unused target heads cannot cause an action. Validate only the selected head.
      const targetAnswer = validateChoice(answers[`${operation.toLowerCase()}_target`] ?? {}, [
        ...candidates.keys(),
        NOT_VISIBLE,
      ]);
      target = targetAnswer.choice;
      confidences.push(targetAnswer.confidence);
      if (target === NOT_VISIBLE) {
        // Jev looked for a target it cannot see. Nothing runs; the loop asks again with this noted.
        return new Decision(NOT_VISIBLE, null, { confidence: Math.min(...confidences), wanted: operation });
      }
    }
    const decision = resolve(page, operation, target);
    if (operation === "TYPE_TEXT") {
      const valueAnswer = validateChoice(answers.type_text_value ?? {}, [...values.keys(), NO_VALUE]);
      confidences.push(valueAnswer.confidence);
      if (valueAnswer.choice !== NO_VALUE) decision.text = (values.get(valueAnswer.choice) as Value).value;
    }
    if (operation === "UPLOAD_FILE") {
      const fileAnswer = validateChoice(answers.upload_file_file ?? {}, [...files.keys(), NO_VALUE]);
      confidences.push(fileAnswer.confidence);
      if (fileAnswer.choice !== NO_VALUE) decision.text = (files.get(fileAnswer.choice) as Value).value;
    }
    decision.confidence = Math.min(...confidences);
    return decision;
  }
}
