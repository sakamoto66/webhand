/**
 * What every model-driven arm shares: the action space, model state builder, and choice resolver.
 *
 * Adapted from jev-ultrafast (MIT); see THIRD_PARTY_LICENSE_jev-ultrafast.txt.
 */

import { quote } from "../core/format.ts";
import {
  type Action,
  Decision,
  type HistoryEntry,
  type Page,
  type Plan,
  PolicyError,
  type Value,
} from "../core/types.ts";
import { ESCALATE, OPERATIONS, TERMINAL_HELP } from "./prompts.ts";

export { OPERATIONS };

const HISTORY_LIMIT = 40;

// biome-ignore lint/suspicious/noExplicitAny: elements mirror the observed actions' fields.
export type Element = Record<string, any>;
/** operation -> target index -> action. Maps keep the observed order; "2" may come before "1". */
export type Targets = Map<string, Map<string, Action>>;
export type Controls = Map<string, Action>;

/** One index per observed element; each operation has its own valid target choices. */
export function actionSpace(actions: Action[]): [Element[], Targets, Controls] {
  const elements: Element[] = [];
  const indices = new Map<unknown, string>();
  const targets: Targets = new Map();
  const controls: Controls = new Map();
  for (const action of actions) {
    const kind = action.kind;
    if (!(kind in OPERATIONS)) {
      controls.set(String(action.id).toUpperCase(), action);
      continue;
    }
    const node = action.node;
    if (!indices.has(node)) {
      const index = String(elements.length + 1);
      indices.set(node, index);
      const element: Element = {};
      for (const key of [
        "role",
        "value",
        "placeholder",
        "pattern",
        "checked",
        "selected",
        "expanded",
        "at",
        "context",
      ]) {
        if (key in action) element[key] = action[key];
      }
      element.index = index;
      element.label = String(action.label).split(" → ")[0];
      element.operations = [];
      if (kind === "select") {
        element.value = "current_value" in action ? action.current_value : "";
        element.options = [];
      }
      elements.push(element);
    }
    const index = indices.get(node) as string;
    const operation = OPERATIONS[kind];
    const element = elements[Number(index) - 1];
    if (!element.operations.includes(operation)) element.operations.push(operation);
    let target = index;
    if (kind === "select") {
      target = `${index}:${element.options.length + 1}`;
      element.options.push({ index: target, label: action.label, value: action.value });
    }
    if (!targets.has(operation)) targets.set(operation, new Map());
    const choices = targets.get(operation) as Map<string, Action>;
    choices.set(target, action); // Like a dict: a repeated target keeps its place and takes the later action.
  }
  return [elements, targets, controls];
}

export function planText(plan: Pick<Plan, "steps">): string[] {
  return plan.steps.map((step, i) => {
    const mark = step.actor === "human" ? "[person] " : "";
    let line = `${i + 1}. ${mark}${step.instruction}`;
    if (step.done_when) line += ` (done when: ${step.done_when})`;
    return line;
  });
}

/** Claude's values, numbered. Jev chooses a number; the text is always Claude's. */
export function valueChoices(plan: Pick<Plan, "values">): Map<string, Value> {
  return new Map((plan.values ?? []).map((value, i) => [String(i + 1), value]));
}

/** Claude's files, numbered. Jev chooses a number; the path is always Claude's. */
export function fileChoices(plan: Pick<Plan, "files">): Map<string, Value> {
  return new Map((plan.files ?? []).map((file, i) => [String(i + 1), file]));
}

/** Pixels of page outside the viewport. Only visible elements are offered, so this says more exists. */
export function offscreen(page: Page): { above_px: number; below_px: number } {
  const scroll = page.scroll || {};
  const height = page.h || 0;
  const y = "y" in scroll ? scroll.y : 0;
  const total = "height" in scroll ? scroll.height : 0;
  const above = Math.round(y);
  const below = height ? Math.max(0, Math.round(total - y - height)) : 0;
  return { above_px: above, below_px: below };
}

/** A dropdown's options once each, as index -> option label. The element's label is not repeated. */
export function compactOptions(element: Element): Element {
  if (!("options" in element)) return element;
  const options: Record<string, string> = {};
  for (const option of element.options) options[option.index] = String(option.label).split(" → ").at(-1) as string;
  return { ...element, options };
}

/**
 * The goal Jev works toward. After a comparison, the item it found; after a collection, the part of the goal about
 * reading the list is done.
 */
export function jevGoal(plan: Plan): string {
  if (plan.compared?.best) {
    return `Act on the item found by comparing the whole list for "${plan.compared.criterion}": ${plan.compared.best}.`;
  }
  if (!plan.collected || !plan.steps.length) return plan.goal;
  const values = plan.values.map((value) => `${value.label}: ${value.value}`).join("; ");
  return `${planText(plan).join(" ")}${values ? ` Values Claude wrote: ${values}.` : ""}`;
}

export function modelState(page: Page, history: HistoryEntry[], plan: Plan | null = null): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (plan) {
    const service = plan.service || ({} as { description?: string; facts?: string[] });
    const hints = plan.steps.flatMap((step) => step.hints ?? []);
    if (Object.keys(service).length || hints.length) {
      state.service = {
        description: service.description ?? "",
        facts: [...(service.facts ?? []), ...hints],
      };
    }
    state.plan = {
      goal: jevGoal(plan),
      steps: planText(plan),
      attempt: plan.attempt ?? 1,
      notes_from_earlier_attempts: plan.notes ?? [],
    };
    if (plan.compared) (state.plan as Record<string, unknown>).compared = plan.compared;
    if (plan.instructions?.length) (state.plan as Record<string, unknown>).claude_instructions = plan.instructions;
  }
  const shown: Record<string, unknown> = { url: page.url, title: page.title, text: page.text };
  shown.offscreen = offscreen(page);
  if (page.status) shown.status = page.status;
  if (page.tabs) shown.tabs = page.tabs;
  if (page.regions?.length) shown.regions = page.regions;
  if (page.read) shown.read = { text: page.read.text, chars: page.read.chars };
  if (page.areas_map?.length) shown.areas = page.areas_map;
  if (page.hidden_elements) shown.hidden_elements = page.hidden_elements;
  state.page = shown;
  if (page.known?.length) {
    state.known_from_earlier_runs = {
      note:
        "Operations that were among the steps of earlier runs on this site that finished as done, for pages like this one. " +
        "They may not fit this goal: use one only when it serves the goal and is offered below.",
      operations: page.known,
    };
  }
  state.elements = actionSpace(page.actions)[0].map(compactOptions);
  state.action_history = history.slice(-HISTORY_LIMIT).map((h) => {
    const entry: Record<string, unknown> = {};
    for (const key of ["attempt", "action", "kind", "text", "url", "page_changed"]) entry[key] = h[key] ?? null;
    // An upload's text is the file's path: Jev gets the label only, or nothing when the plan no longer names it.
    if (h.kind === "upload") entry.text = plan?.files?.find((file) => file.value === h.text)?.label ?? null;
    return entry;
  });
  return state;
}

/** Map a model's choice to an observed action. Anything else is rejected, not repaired. */
export function resolve(page: Page, operation: string, target: string | null | undefined): Decision {
  if (operation in TERMINAL_HELP || operation === ESCALATE) return new Decision(operation);
  const [, targets, controls] = actionSpace(page.actions);
  const control = controls.get(operation);
  if (control) return new Decision(operation, control);
  const choices = targets.get(operation);
  if (!choices) throw new PolicyError(`Operation ${quote(operation)} is unavailable; no action executed.`);
  const action = target === null || target === undefined ? undefined : choices.get(target);
  if (!action)
    throw new PolicyError(`Target ${quote(target ?? null)} is invalid for ${operation}; no action executed.`);
  return new Decision(operation, action);
}
