/**
 * What Jev is asked: the questions for each kind of request (choose, compare, more, collect).
 * Nothing here talks to Jev; jev.ts sends what this builds.
 */

import type { Action, Page, Plan, Value } from "../core/types.ts";
import { MATCH, NO, type Row } from "../scans/collect.ts";
import { type Best, type Candidate, describeBest, KEEP, NONE } from "../scans/compare.ts";
import type { LabelView, LinkView } from "../scans/drilldown.ts";
import { type Controls, jevGoal, modelState, planText, type Targets } from "./base.ts";
import {
  BLOCK_SELECT_RULES,
  CLAIM_MET,
  CLAIM_NOT_MET,
  CLAIM_UNKNOWN,
  COLLECT_RULES,
  COMPARE_RULES,
  COMPARED_RULES,
  DETAIL_LINK_CHOICE,
  DETAIL_LINK_EXISTS,
  DETAIL_LINK_RULES,
  ESCALATE,
  ESCALATE_HELP,
  ESCALATE_RULES,
  FIELD_CHOICE,
  FIELD_EXISTS,
  FIELD_RULES,
  FILE,
  INSTRUCTION_RULES,
  MORE_RULES,
  NEXT_ACTION,
  NEXT_ACTION_WHOLE,
  NOT_VISIBLE,
  NOT_VISIBLE_HELP,
  OPERATION_HELP,
  READ_RULES,
  READ_RULES_WHOLE,
  RECOVERY_RULES,
  RECOVERY_STRATEGIES,
  REGION_ALL,
  REGION_RULES,
  TAB_RULES,
  TARGET,
  TERMINAL_HELP,
  VALUE,
  VERIFY_CLAIMS_RULES,
} from "./prompts.ts";

export const NO_VALUE = "NONE";

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
  for (const key of ["role", "checked", "selected", "expanded", "at", "context"]) {
    if (key in action) criterion[key] = action[key];
  }
  return criterion;
}

function formatCandidateCriterion(item: Candidate): string {
  const context = item.context && item.context !== item.action.label ? ` — ${item.context}` : "";
  return `[${item.key}] ${item.action.label}${context}`;
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
  const readRules = plan.flow === "v2" ? READ_RULES_WHOLE : READ_RULES;
  const rules = [
    next,
    ...(reading ? [readRules] : []),
    ...(tabbed ? [TAB_RULES] : []),
    ...(plan.compared ? [COMPARED_RULES] : []),
    ...(plan.instructions?.length ? [INSTRUCTION_RULES] : []),
    ...(plan.flow === "v2" ? [ESCALATE_RULES] : []),
  ].join("\n");
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
  for (const item of candidates) criteria.set(item.key, formatCandidateCriterion(item));
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
  for (const item of candidates) criteria.set(item.key, formatCandidateCriterion(item));
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

export interface RegionCandidate {
  key: string;
  region: string;
  summary: string;
}

/** Stage-1 question for 2-stage Jev: pick one region to focus on, or ALL for the whole page. */
export function buildRegionQuestion(plan: Plan, regions: RegionCandidate[]): Record<string, unknown> {
  const criteria = new Map<string, string>();
  for (const item of regions) criteria.set(item.key, `${item.region} — ${item.summary}`);
  criteria.set(REGION_ALL, "Use the whole page (goal already satisfied, terminal choice, or unsure which region)");
  return {
    region: {
      type: "choice",
      criteria,
      instructions: { ...taskBrief(plan), rules: REGION_RULES },
    },
  };
}

/** Parallel verification questions: one MET/NOT_MET/UNKNOWN choice per completion claim. */
export function buildVerifyClaims(plan: Plan, claims: string[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  const brief = taskBrief(plan);
  claims.forEach((claim, i) => {
    questions[`claim_${i + 1}`] = {
      type: "choice",
      criteria: new Map([
        [CLAIM_MET, `Visibly satisfied on this page: ${claim}`],
        [CLAIM_NOT_MET, `Not yet satisfied on this page: ${claim}`],
        [CLAIM_UNKNOWN, "Cannot tell from the current page observation"],
      ]),
      instructions: { ...brief, claim, rules: VERIFY_CLAIMS_RULES },
    };
  });
  return questions;
}

/** Non-destructive tactical recovery choice before stopping an attempt as STUCK. */
export function buildRecoveryQuestion(plan: Plan): Record<string, unknown> {
  return {
    recovery: {
      type: "choice",
      criteria: new Map(Object.entries(RECOVERY_STRATEGIES)),
      instructions: { ...taskBrief(plan), rules: RECOVERY_RULES },
    },
  };
}

/** Parallel relevance questions for selecting answer blocks from a read-only page. */
export function buildBlockSelect(query: string, blocks: { key: string; text: string }[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const block of blocks) {
    questions[`block_${block.key}`] = {
      type: "choice",
      criteria: new Map([
        [MATCH, `Relevant to: ${query}`],
        [NO, "Not relevant (chrome, navigation, or unrelated content)"],
      ]),
      instructions: { query, block: block.text, rules: BLOCK_SELECT_RULES },
    };
  }
  return questions;
}

/** Parallel noul (0..1 probability) questions, evaluated independently against a shared state. */
export function buildNoulQuestions(items: { key: string; instructions: unknown }[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const item of items) {
    questions[item.key] = {
      type: "noul",
      instructions: item.instructions,
    };
  }
  return questions;
}

/** The drilldown link questions: whether the row has a detail link, and which. A lone link needs no choice. */
export function buildDetailLink(links: LinkView[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {
    has_detail_link: { type: "noul", instructions: { question: DETAIL_LINK_EXISTS, rules: DETAIL_LINK_RULES } },
  };
  if (links.length > 1) {
    questions.detail_link = {
      type: "choice",
      criteria: new Map(links.map((link) => [link.key, `[${link.key}] ${link.name || "(no name)"} → ${link.path}`])),
      instructions: { question: DETAIL_LINK_CHOICE, rules: DETAIL_LINK_RULES },
    };
  }
  return questions;
}

/**
 * The drilldown field questions, for each word of --fields (numbered from 1): whether a field name fits it, and which.
 * A lone name needs no choice.
 */
export function buildFieldMatch(wanted: string[], labels: LabelView[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  wanted.forEach((word, i) => {
    questions[`field_${i + 1}_exists`] = {
      type: "noul",
      instructions: { question: FIELD_EXISTS, user_field: word, rules: FIELD_RULES },
    };
    if (labels.length > 1) {
      questions[`field_${i + 1}`] = {
        type: "choice",
        criteria: new Map(labels.map((item) => [item.key, `[${item.key}] ${item.label}`])),
        instructions: { question: FIELD_CHOICE, user_field: word, rules: FIELD_RULES },
      };
    }
  });
  return questions;
}
