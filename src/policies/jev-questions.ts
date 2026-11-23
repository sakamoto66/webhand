/**
 * What Jev is asked: the questions for each kind of request (choose, compare, more, collect), and fitting a request
 * under Jev's token and choice limits. Nothing here talks to Jev; jev.ts sends what this builds.
 */

import { MATCH, NO, type Row } from "../collect.ts";
import { type Best, type Candidate, describeBest, KEEP, NONE } from "../compare.ts";
import { toJson } from "../format.ts";
import type { Action, Page, Plan, Value } from "../types.ts";
import {
  COLLECT_RULES,
  COMPARE_RULES,
  COMPARED_RULES,
  type Controls,
  ESCALATE,
  ESCALATE_HELP,
  ESCALATE_RULES,
  FILE,
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
  TAB_RULES,
  TARGET,
  type Targets,
  TERMINAL_HELP,
  VALUE,
} from "./base.ts";

export const NO_VALUE = "NONE";

// Jev refuses a request over its token limit (HTTP 400 max_tokens_exceeded) and a question with more than 255
// choices (HTTP 422), found 2026-11-13. The estimate below read lower than Jev's count on real pages, by up to 1.5
// times, and the limit sits at about 24k estimated tokens: in round ff, all 320 requests that went through held
// 23,876 or fewer, and all 8 refused held 24,987 or more (rounds fc to ff showed that 40k, the first budget, was
// refused again and again, and the budget lowered by a refusal stayed lowered for the run). A refusal still lowers
// the budget and the request is fitted again; nothing runs in the browser in between.
export const TOKEN_BUDGET = 24_000;
const MAX_CHOICES = 255;
export const OVER_LIMIT = "max_tokens_exceeded";
export const FIT_TRIES = 3;
export const SHRINK = 0.6;

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
export function requestSize(fitted: {
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

function criteriaSize(question: unknown): number {
  const criteria = (question as { criteria: Map<string, unknown> | Record<string, unknown> }).criteria;
  return criteria instanceof Map ? criteria.size : Object.keys(criteria).length;
}

function fits(body: unknown, questions: Record<string, unknown>, budget: number): boolean {
  for (const question of Object.values(questions)) {
    if (criteriaSize(question) > MAX_CHOICES) return false;
  }
  return estimateTokens(toJson(body)) <= budget;
}

function overChoiceLimit(questions: Record<string, unknown>): { op: string; excess: number }[] {
  const over: { op: string; excess: number }[] = [];
  for (const [name, question] of Object.entries(questions)) {
    const size = criteriaSize(question);
    if (size > MAX_CHOICES && name.endsWith("_target")) {
      over.push({ op: name.slice(0, -"_target".length).toUpperCase(), excess: size - MAX_CHOICES });
    }
  }
  return over;
}

const pixels = (action: Action): number => Number(/(\d+)px/.exec(String(action.at ?? ""))?.[1] ?? 0);

/**
 * Asks about the page as observed when the request fits Jev's limits. Otherwise elements are left out until it
 * fits: first, any operation whose target question exceeds MAX_CHOICES drops only its own nodes (farthest offscreen
 * first, then the largest in-view node such as a 248-option Country dropdown so unrelated buttons/inputs stay);
 * then, if still over the token budget, remaining elements drop farthest offscreen first and in-view from the end.
 * Controls (wait, scroll, reveal) stay. Jev can still answer NOT_VISIBLE, and nothing left out can be chosen.
 */
export function fitChoose<T extends { body: unknown; questions: Record<string, unknown> }>(
  page: Page,
  build: (page: Page) => T,
  budget: number,
): T & { page: Page; dropped: number } {
  let built = build(page);
  if (fits(built.body, built.questions, budget)) return { ...built, page, dropped: 0 };
  const nodes = new Map<
    unknown,
    { offscreen: boolean; distance: number; order: number; opCounts: Map<string, number> }
  >();
  for (const action of page.actions) {
    const op = OPERATIONS[action.kind];
    if (!op) continue;
    let info = nodes.get(action.node);
    if (!info) {
      info = { offscreen: Boolean(action.offscreen), distance: pixels(action), order: nodes.size, opCounts: new Map() };
      nodes.set(action.node, info);
    }
    info.opCounts.set(op, (info.opCounts.get(op) ?? 0) + 1);
  }
  const left = new Set<unknown>();
  let asked = page;
  const rebuild = () => {
    asked = { ...page, actions: page.actions.filter((a: Action) => !(a.kind in OPERATIONS && left.has(a.node))) };
    built = build(asked);
  };
  for (const { op, excess } of overChoiceLimit(built.questions)) {
    const candidates = [...nodes]
      .filter(([node, info]) => !left.has(node) && (info.opCounts.get(op) ?? 0) > 0)
      .sort(
        ([, a], [, b]) =>
          Number(b.offscreen) - Number(a.offscreen) ||
          b.distance - a.distance ||
          (b.opCounts.get(op) ?? 0) - (a.opCounts.get(op) ?? 0) ||
          b.order - a.order,
      );
    let removed = 0;
    for (const [node, info] of candidates) {
      if (removed >= excess) break;
      left.add(node);
      removed += info.opCounts.get(op) ?? 0;
    }
  }
  if (left.size) {
    rebuild();
    if (fits(built.body, built.questions, budget)) return { ...built, page: asked, dropped: left.size };
  }
  const remaining = [...nodes]
    .filter(([node]) => !left.has(node))
    .sort(([, a], [, b]) => Number(b.offscreen) - Number(a.offscreen) || b.distance - a.distance || b.order - a.order);
  let cursor = 0;
  while (cursor < remaining.length) {
    const step = Math.max(1, Math.ceil((remaining.length - cursor) / 10));
    for (const [node] of remaining.slice(cursor, cursor + step)) left.add(node);
    cursor += step;
    rebuild();
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
  files: Map<string, Value> = new Map(),
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
  if (targets.has("UPLOAD_FILE")) {
    // Only the label: the path may hold a name, and Jev does not need it to choose.
    const criteria = new Map<string, string>();
    for (const [key, f] of files) criteria.set(key, f.label);
    criteria.set(NO_VALUE, "No listed file belongs in the field");
    questions.upload_file_file = {
      type: "choice",
      criteria,
      instructions: { ...brief, operation: "UPLOAD_FILE", rules: [FILE] },
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
