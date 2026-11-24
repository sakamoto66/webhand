/** Progress tracking, stuck/looping detectors, page comparison, and attempt stop conditions. */

import type { HistoryEntry, Page, Plan } from "../core/types.ts";
import { ATTEMPT_BUDGET, type Budget, MISSING, STALE, STUCK } from "./outcomes.ts";

/** Executed actions only, in every attempt: not a person's step, a NOT_VISIBLE choice, or a refused stale one. */
export function executed(history: HistoryEntry[]): HistoryEntry[] {
  return history.filter((h) => !["human", "answer", MISSING, STALE].includes(h.kind));
}

/** Executed actions of one attempt; they count against the budget. */
export function actionsIn(history: HistoryEntry[], attempt: number): HistoryEntry[] {
  return executed(history).filter((h) => (h.attempt ?? 1) === attempt);
}

/** Three entries without progress: unchanged pages, targets Jev could not see, or refused stale choices. */
function stuck(history: HistoryEntry[], attempt = 1): boolean {
  const recent = history.filter((h) => (h.attempt ?? 1) === attempt && h.kind !== "human").slice(-3);
  return recent.length === 3 && recent.every((s) => s.page_changed === false && s.kind !== "wait");
}

/** Entries of this attempt after Claude's last answer: an answer starts the count again, so Jev is asked before any stop. */
function sinceAnswer(history: HistoryEntry[], attempt: number): HistoryEntry[] {
  const own = history.filter((h) => (h.attempt ?? 1) === attempt && h.kind !== "human");
  const last = own.map((h) => h.kind).lastIndexOf("answer");
  return own.slice(last + 1);
}

/** v2: back and forth scrolling (three round trips) with nothing else done between. Each scroll changes the page, so stuck() never sees it. */
export function looping(history: HistoryEntry[], attempt = 1): boolean {
  const recent = sinceAnswer(history, attempt).slice(-6);
  const scrolls = recent.map((h) => h.operation);
  return (
    recent.length === 6 &&
    scrolls.every((op, i) => (op === "SCROLL_DOWN" || op === "SCROLL_UP") && (i === 0 || op !== scrolls[i - 1]))
  );
}

/** How many frames, canvases, and plugin objects the page has: parts webhand cannot see into. */
export function unseenParts(page: Page): number {
  const unseen = (page.status?.unseen ?? {}) as Record<string, number>;
  return (unseen.frames ?? 0) + (unseen.canvases ?? 0) + (unseen.objects ?? 0);
}

/** v2: the needed element was not offered twice in a row, on a page with parts webhand cannot see into. */
function missingInUnseen(history: HistoryEntry[], page: Page, attempt = 1): boolean {
  const recent = sinceAnswer(history, attempt).slice(-2);
  return recent.length === 2 && recent.every((h) => h.kind === MISSING) && unseenParts(page) > 0;
}

/** Markers are JSON values from the page; equal content means the same page. */
function sameMarker(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The same page in the same tab setup and frames: a new or closed tab, a switch, or a change inside a frame is a change even when the page is not. */
export function samePage(a: Page, b: Page): boolean {
  return (
    sameMarker(a.marker, b.marker) &&
    sameMarker(a.tabs ?? null, b.tabs ?? null) &&
    sameMarker(a.frame_markers ?? null, b.frame_markers ?? null)
  );
}

/** Why the attempt stops before Jev is asked again: [outcome, detail], or null to go on. */
export function stopReason(
  plan: Plan,
  history: HistoryEntry[],
  page: Page,
  attempt: number,
  budget: Budget,
  decisions: number,
): [string, string] | null {
  if (stuck(history, attempt)) return [STUCK, "three actions without a page change"];
  if (plan.flow === "v2") {
    if (looping(history, attempt)) return [STUCK, "scrolled up and down three times with nothing else done"];
    if (missingInUnseen(history, page, attempt)) {
      return [STUCK, "the needed element was not offered twice, and the page has parts webhand cannot see"];
    }
  }
  const done = actionsIn(history, attempt).length;
  if (done >= budget.maxActions || decisions >= budget.maxDecisions) {
    return [ATTEMPT_BUDGET, `${done} actions, ${decisions} decisions`];
  }
  return null;
}
