/**
 * Jev's role: choose the next operation, target, and value toward Claude's goal, one page at a time.
 *
 * Adapted from jev-ultrafast (MIT); see THIRD_PARTY_LICENSE_jev-ultrafast.txt.
 */

import { Agent, fetch as undiciFetch } from "undici";
import { pyJson, pyRound, sleep } from "../py.ts";
import {
  type Action,
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
import {
  actionSpace,
  type Controls,
  modelState,
  NEXT_ACTION,
  NOT_VISIBLE,
  NOT_VISIBLE_HELP,
  OPERATION_HELP,
  planText,
  resolve,
  TARGET,
  type Targets,
  TERMINAL_HELP,
  VALUE,
  valueChoices,
} from "./base.ts";

export const URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 25_000;

/** The subset of fetch that JevPolicy uses, so tests can answer without a network. */
export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

// biome-ignore lint/suspicious/noExplicitAny: Jev's response is validated field by field.
type Json = any;

async function postJson(fetchJson: Fetch, key: string, body: unknown): Promise<Json> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Awaited<ReturnType<Fetch>>;
    try {
      response = await fetchJson(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: pyJson(body, true),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PolicyError("Jev connection failed; no action executed.");
    }
    if ([429, 503, 529].includes(response.status) && attempt < 2) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (response.status >= 400) throw new PolicyError(`Jev returned HTTP ${response.status}; no action executed.`);
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

export const NO_VALUE = "NONE";

/** Claude's plan travels with every question, not only in the state. */
function taskBrief(plan: Plan): Record<string, unknown> {
  const brief: Record<string, unknown> = { goal: plan.goal };
  if (plan.steps?.length) brief.plan = planText(plan);
  if (plan.notes?.length) brief.notes_from_earlier_attempts = plan.notes;
  return brief;
}

/** A dropdown option is only its label: the dropdown's current value is in the state's elements. */
function targetCriterion(operation: string, index: string, action: Action): unknown {
  if (operation === "SELECT") return `[${index}] ${action.label}`;
  const criterion: Record<string, unknown> = {
    element: `[${index}] ${action.label}`,
    current_value: "current_value" in action ? action.current_value : "value" in action ? action.value : "",
  };
  for (const key of ["role", "checked", "selected", "expanded"]) if (key in action) criterion[key] = action[key];
  return criterion;
}

export function buildQuestions(
  plan: Plan,
  targets: Targets,
  controls: Controls,
  values: Map<string, Value>,
): [Record<string, unknown>, Record<string, string>] {
  const brief = taskBrief(plan);
  const operations: Record<string, string> = {};
  for (const key of targets.keys()) operations[key] = OPERATION_HELP[key];
  for (const [key, value] of controls) operations[key] = value.label;
  Object.assign(operations, TERMINAL_HELP);
  const questions: Record<string, unknown> = {
    operation: { type: "choice", criteria: operations, instructions: { ...brief, rules: NEXT_ACTION } },
  };
  for (const [operation, candidates] of targets) {
    const criteria = new Map<string, unknown>();
    for (const [index, action] of candidates) criteria.set(index, targetCriterion(operation, index, action));
    criteria.set(NOT_VISIBLE, NOT_VISIBLE_HELP);
    questions[`${operation.toLowerCase()}_target`] = {
      type: "choice",
      criteria,
      instructions: { ...brief, operation, rules: [NEXT_ACTION, TARGET] },
    };
  }
  if (targets.has("TYPE_TEXT")) {
    const criteria = new Map<string, string>();
    for (const [key, v] of values) criteria.set(key, `${v.label}: ${v.value}`);
    criteria.set(NO_VALUE, "No listed value belongs in the field");
    questions.type_text_value = {
      type: "choice",
      criteria,
      instructions: { ...brief, operation: "TYPE_TEXT", rules: [VALUE] },
    };
  }
  return [questions, operations];
}

export class JevPolicy implements Policy {
  name = "jev";
  calls: ModelCall[] = [];
  servedModel: string | null = null;
  readonly key: string;
  readonly model: string;
  private readonly fetchJson: Fetch;
  private readonly agent: Agent | null;

  constructor(options: { fetch?: Fetch } = {}) {
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw new PolicyError("TYPESAFE_API_KEY is not set.");
    this.key = key;
    this.model = process.env.TYPESAFE_MODEL ?? "jev-latest";
    if (options.fetch) {
      this.fetchJson = options.fetch;
      this.agent = null;
    } else {
      // HTTP/2 when the server offers it, as the Python client did; HTTP/1.1 otherwise.
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

  async choose(page: Page, plan: Plan, history: HistoryEntry[]): Promise<Decision> {
    const [, targets, controls] = actionSpace(page.actions);
    const values = valueChoices(plan);
    const [questions, operations] = buildQuestions(plan, targets, controls, values);
    const body = { model: this.model, state: modelState(page, history, plan), questions };
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
        "choose",
        pyRound(performance.now() - started),
        "input_tokens" in usage ? usage.input_tokens : (usage.prompt_tokens ?? null),
        "output_tokens" in usage ? usage.output_tokens : (usage.completion_tokens ?? null),
      ),
    );
    const answers = (isObject && result.answers) || {};
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
    decision.confidence = Math.min(...confidences);
    return decision;
  }
}
