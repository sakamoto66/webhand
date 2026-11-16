/**
 * Jev's role: choose the next operation, target, and value toward Claude's goal, one page at a time.
 *
 * Adapted from jev-ultrafast (MIT); see THIRD_PARTY_LICENSE_jev-ultrafast.txt.
 */

import { Agent, fetch as undiciFetch } from "undici";
import { MATCH, NO, type Row } from "../collect.ts";
import { type Best, type Candidate, describeBest, KEEP, NONE } from "../compare.ts";
import { sleep, toJson } from "../format.ts";
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
  COLLECT_RULES,
  COMPARE_RULES,
  COMPARED_RULES,
  type Controls,
  ESCALATE,
  ESCALATE_HELP,
  ESCALATE_RULES,
  INSTRUCTION_RULES,
  jevGoal,
  MORE_RULES,
  modelState,
  NEXT_ACTION,
  NEXT_ACTION_WHOLE,
  NOT_VISIBLE,
  NOT_VISIBLE_HELP,
  OPERATION_HELP,
  OPERATIONS,
  planText,
  READ_RULES,
  resolve,
  TAB_RULES,
  TARGET,
  type Targets,
  TERMINAL_HELP,
  VALUE,
  valueChoices,
} from "./base.ts";

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

const NO_VALUE = "NONE";

// Jev refuses a request over its token limit (HTTP 400 max_tokens_exceeded) and a question with more than 255
// choices (HTTP 422), found 2026-11-13. The estimate below read lower than Jev's count on real pages, by up to 1.5
// times, and the limit sits at about 24k estimated tokens: in round ff, all 320 requests that went through held
// 23,876 or fewer, and all 8 refused held 24,987 or more (rounds fc to ff showed that 40k, the first budget, was
// refused again and again, and the budget lowered by a refusal stayed lowered for the run). A refusal still lowers
// the budget and the request is fitted again; nothing runs in the browser in between.
const TOKEN_BUDGET = 24_000;
const MAX_CHOICES = 255;
const OVER_LIMIT = "max_tokens_exceeded";
const FIT_TRIES = 3;
const SHRINK = 0.6;

/** A rough token count: about 3 characters a token for ASCII, 1.5 tokens for each other character (such as CJK). */
export function estimateTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 3 + (text.length - ascii) * 1.5);
}

/** The number of choices over all questions of a request. */
function choiceCount(questions: Record<string, unknown>): number {
  let total = 0;
  for (const question of Object.values(questions)) {
    const criteria = (question as { criteria: Map<string, unknown> | Record<string, unknown> }).criteria;
    total += criteria instanceof Map ? criteria.size : Object.keys(criteria).length;
  }
  return total;
}

/** What a request holds, as counts: for the run log, so a refusal can be set beside the requests that went through. */
function requestSize(fitted: {
  body: unknown;
  questions: Record<string, unknown>;
  targets?: Map<string, Map<string, unknown>>;
}) {
  const chars = toJson(fitted.body);
  return {
    estimated_tokens: estimateTokens(chars),
    request_chars: chars.length,
    choices: choiceCount(fitted.questions),
    elements: fitted.targets ? [...fitted.targets.values()].reduce((n, m) => n + m.size, 0) : 0,
  };
}

function fits(body: unknown, questions: Record<string, unknown>, budget: number): boolean {
  for (const question of Object.values(questions)) {
    const criteria = (question as { criteria: Map<string, unknown> | Record<string, unknown> }).criteria;
    if ((criteria instanceof Map ? criteria.size : Object.keys(criteria).length) > MAX_CHOICES) return false;
  }
  return estimateTokens(toJson(body)) <= budget;
}

const pixels = (action: Action): number => Number(/(\d+)px/.exec(String(action.at ?? ""))?.[1] ?? 0);

/**
 * Asks about the page as observed when the request fits Jev's limits. Otherwise elements are left out until it
 * fits: beyond the viewport the farthest first, then those in view from the end of the page. Controls (wait,
 * scroll, reveal) stay. Jev can still answer NOT_VISIBLE, and nothing left out can be chosen.
 */
function fitChoose<T extends { body: unknown; questions: Record<string, unknown> }>(
  page: Page,
  build: (page: Page) => T,
  budget: number,
): T & { page: Page; dropped: number } {
  let built = build(page);
  if (fits(built.body, built.questions, budget)) return { ...built, page, dropped: 0 };
  const nodes = new Map<unknown, { offscreen: boolean; distance: number; order: number }>();
  for (const action of page.actions) {
    if (!(action.kind in OPERATIONS) || nodes.has(action.node)) continue;
    nodes.set(action.node, { offscreen: Boolean(action.offscreen), distance: pixels(action), order: nodes.size });
  }
  const order = [...nodes].sort(
    ([, a], [, b]) => Number(b.offscreen) - Number(a.offscreen) || b.distance - a.distance || b.order - a.order,
  );
  const left = new Set<unknown>();
  let asked = page;
  while (left.size < order.length) {
    const step = Math.max(1, Math.ceil((order.length - left.size) / 10));
    for (const [node] of order.slice(left.size, left.size + step)) left.add(node);
    asked = { ...page, actions: page.actions.filter((a: Action) => !(a.kind in OPERATIONS && left.has(a.node))) };
    built = build(asked);
    if (fits(built.body, built.questions, budget)) break;
  }
  return { ...built, page: asked, dropped: left.size };
}

/** Claude's plan travels with every question, not only in the state. */
function taskBrief(plan: Plan): Record<string, unknown> {
  const brief: Record<string, unknown> = { goal: jevGoal(plan) };
  if (plan.steps?.length) brief.plan = planText(plan);
  if (plan.notes?.length) brief.notes_from_earlier_attempts = plan.notes;
  if (plan.instructions?.length) brief.claude_instructions = plan.instructions;
  return brief;
}

/** A dropdown option is only its label: the dropdown's current value is in the state's elements. */
function targetCriterion(operation: string, index: string, action: Action): unknown {
  if (operation === "SELECT") return `[${index}] ${action.label}`;
  const criterion: Record<string, unknown> = {
    element: `[${index}] ${action.label}`,
    current_value: "current_value" in action ? action.current_value : "value" in action ? action.value : "",
  };
  for (const key of ["role", "checked", "selected", "expanded", "at"]) if (key in action) criterion[key] = action[key];
  return criterion;
}

export function buildQuestions(
  plan: Plan,
  targets: Targets,
  controls: Controls,
  values: Map<string, Value>,
  reading = false,
  tabbed = false,
): [Record<string, unknown>, Record<string, string>] {
  const brief = taskBrief(plan);
  const next = plan.flow === "v2" ? NEXT_ACTION_WHOLE : NEXT_ACTION;
  let rules = reading ? `${next}\n${READ_RULES}` : next;
  if (tabbed) rules = `${rules}\n${TAB_RULES}`;
  if (plan.compared) rules = `${rules}\n${COMPARED_RULES}`;
  if (plan.instructions?.length) rules = `${rules}\n${INSTRUCTION_RULES}`;
  if (plan.flow === "v2") rules = `${rules}\n${ESCALATE_RULES}`;
  const operations: Record<string, string> = {};
  for (const key of targets.keys()) operations[key] = OPERATION_HELP[key];
  for (const [key, value] of controls) operations[key] = value.label;
  Object.assign(operations, TERMINAL_HELP);
  if (plan.flow === "v2") operations[ESCALATE] = ESCALATE_HELP;
  const questions: Record<string, unknown> = {
    operation: { type: "choice", criteria: operations, instructions: { ...brief, rules } },
  };
  for (const [operation, candidates] of targets) {
    const criteria = new Map<string, unknown>();
    for (const [index, action] of candidates) criteria.set(index, targetCriterion(operation, index, action));
    criteria.set(NOT_VISIBLE, NOT_VISIBLE_HELP);
    questions[`${operation.toLowerCase()}_target`] = {
      type: "choice",
      criteria,
      instructions: { ...brief, operation, rules: [rules, TARGET] },
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

/** The comparison question: items in view, and the best one so far or NONE. */
export function buildCompare(
  plan: Plan,
  criterion: string,
  best: Best | null,
  candidates: Candidate[],
): Record<string, unknown> {
  const criteria = new Map<string, string>();
  for (const item of candidates) {
    const context = item.context && item.context !== item.action.label ? ` — ${item.context}` : "";
    criteria.set(item.key, `[${item.key}] ${item.action.label}${context}`);
  }
  if (best) criteria.set(KEEP, `Keep the current best: ${describeBest(best)}`);
  else criteria.set(NONE, "No listed item fits the criterion");
  return {
    compare: {
      type: "choice",
      criteria,
      instructions: { ...taskBrief(plan), criterion, current_best: describeBest(best), rules: COMPARE_RULES },
    },
  };
}

/** The question that finds Claude's control for more items among the elements in view, or NONE. */
export function buildMore(control: string, candidates: Candidate[]): Record<string, unknown> {
  const criteria = new Map<string, string>();
  for (const item of candidates) {
    const context = item.context && item.context !== item.action.label ? ` — ${item.context}` : "";
    criteria.set(item.key, `[${item.key}] ${item.action.label}${context}`);
  }
  criteria.set(NONE, "Claude's control is not listed, or it is disabled");
  return { more: { type: "choice", criteria, instructions: { control, rules: MORE_RULES } } };
}

/** The collection questions: one per item, MATCH or NO. The plan is in the state. */
export function buildCollect(criterion: string, rows: Row[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const row of rows) {
    questions[`item_${row.key}`] = {
      type: "choice",
      criteria: new Map([
        [MATCH, `It meets the criterion: ${criterion}`],
        [NO, "It does not, its text does not show it, or it is not an item of the list"],
      ]),
      instructions: { criterion, item: row.text, rules: COLLECT_RULES },
    };
  }
  return questions;
}

/**
 * The comparison's state: the plan only, not the page. With the page in the state, Jev favoured an item on
 * screen over a better best that had scrolled away. Each item's own text is in the question.
 */
export function compareState(page: Page, plan: Plan): Record<string, unknown> {
  const { page: _page, elements: _elements, action_history: _history, ...state } = modelState(page, [], plan);
  return state;
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
    const build = (page: Page) => {
      const [, targets, controls] = actionSpace(page.actions);
      const [questions, operations] = buildQuestions(
        plan,
        targets,
        controls,
        values,
        Boolean(page.read),
        Boolean(page.tabs),
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
    decision.confidence = Math.min(...confidences);
    return decision;
  }
}
