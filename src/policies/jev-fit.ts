/** Token-budget and per-question choice-limit fitting for Jev requests. */

import { toJson } from "../core/format.ts";
import type { Action, Page } from "../core/types.ts";
import { OPERATIONS } from "./prompts.ts";

// Jev refuses a request over its token limit (HTTP 400 max_tokens_exceeded) and a question with more than 255
// choices (HTTP 422).
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

function criteriaSize(question: unknown): number {
  const criteria = (question as { criteria: Map<string, unknown> | Record<string, unknown> }).criteria;
  return criteria instanceof Map ? criteria.size : Object.keys(criteria).length;
}

/** The number of choices over all questions of a request. */
function choiceCount(questions: Record<string, unknown>): number {
  let total = 0;
  for (const question of Object.values(questions)) total += criteriaSize(question);
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
 * fits: first, any operation whose target question exceeds MAX_CHOICES drops only its own nodes; then, if still
 * over the token budget, remaining elements drop farthest offscreen first and in-view from the end.
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
