/**
 * Jev's loop toward Claude's goal: observe, choose, execute. It stops; it never claims success.
 *
 * The loop returns to Claude only when it cannot continue on its own. The task's verify() decides success.
 */

import type { PageCheck } from "./browser.ts";
import { quote } from "./format.ts";
import type { Knowledge } from "./knowledge.ts";
import { pageEvent, type Recorder, type ScreenshotAfter, safeUrl } from "./metrics.ts";
import {
  type Action,
  Decision,
  type HistoryEntry,
  MutationUncertain,
  type Page,
  type Plan,
  type Policy,
  PolicyError,
  StalePage,
  type Value,
} from "./types.ts";

// Why the loop handed control back to Claude.
export const GOAL_REPORTED = "GOAL_REPORTED"; // Jev chose DONE. Claude checks the page; finish verifies.
export const BLOCKED = "BLOCKED";
export const STUCK = "STUCK"; // Three actions in a row did not change the page.
export const ATTEMPT_BUDGET = "ATTEMPT_BUDGET";
export const NEEDS_HUMAN = "NEEDS_HUMAN"; // A person acts in the window: sign-in, codes, CAPTCHA, [person] steps.
export const NEEDS_VALUE = "NEEDS_VALUE"; // A field needs text and none of Claude's values fits.
export const ESCALATE = "ESCALATE"; // v2: Jev handed the decision to Claude. `answer` continues the same attempt.
export const JEV_FAILED = "JEV_FAILED"; // No usable decision. Nothing was executed.
export const UNCERTAIN = "UNCERTAIN"; // A mutation may have happened. Never retried, never replanned.

/** Per attempt. A replan starts a new attempt with a fresh budget. */
export class Budget {
  static readonly MAX_ACTIONS = 30;
  static readonly MAX_DECISIONS = 60;
  maxActions: number;
  maxDecisions: number;

  constructor(maxActions = Budget.MAX_ACTIONS, maxDecisions = Budget.MAX_DECISIONS) {
    this.maxActions = maxActions;
    this.maxDecisions = maxDecisions;
  }
}

const MISSING = "missing"; // A history entry for a NOT_VISIBLE choice: nothing ran, but Jev must see it.
const STALE = "stale"; // A history entry for a choice the browser refused as stale: nothing ran.

/** What the loop needs from a browser. */
export interface Actor {
  observe(): Promise<Page>;
  fresh(page: Page, action?: Page | null): Promise<boolean>;
  act(action: Page, page: Page, text?: string | null): Promise<void>;
  screenshot?(): Promise<Buffer>;
  check?(): Promise<PageCheck>;
  /** Parts of the page webhand cannot see into, counted for the run log. */
  unseen?(): Promise<Record<string, number>>;
  /** New windows the page asked for since the last call. A browser that cannot open one lists them, so the log shows it. */
  ignoredWindows?(): Promise<string[]>;
}

/** What the observation offered when Jev found the element it needed missing: counts for the run log only. */
function offered(page: Page): Record<string, number> {
  const actions: Action[] = page.actions ?? [];
  const scroll = page.scroll ?? {};
  return {
    in_view: actions.filter((a) => a.kind !== "reveal").length,
    offscreen: actions.filter((a) => a.kind === "reveal").length,
    omitted_actions: page.omitted_actions ?? 0,
    omitted_reveals: page.omitted_reveals ?? 0,
    regions_with_offscreen: (page.regions ?? []).filter((r: { offscreen_actions?: number }) => r.offscreen_actions)
      .length,
    below_px: Math.max(0, Math.round((scroll.height ?? 0) - (scroll.y ?? 0) - (page.h ?? 0))),
  };
}

/** Outcomes after which the log keeps a page check, to tell a bot check or an error page from a plan problem. */
export const CHECKED_OUTCOMES = [BLOCKED, STUCK, ATTEMPT_BUDGET, NEEDS_HUMAN];

/** Logs a page_check event. Read-only, never sent to Jev; a failed check is logged and never stops the run. */
export async function checkPage(
  browser: Actor,
  recorder: Recorder,
  when: "start" | "escalation",
  attempt: number,
  url: unknown,
): Promise<void> {
  if (!browser.check) return;
  try {
    recorder.event("page_check", { when, attempt, url: safeUrl(url), ...(await browser.check()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recorder.event("page_check_failed", { when, attempt, error: message });
  }
}

/**
 * Opt-in with WEBHAND_SCREENSHOTS=1: the harness, not a model, captures the page after each action so an
 * outside judge can check the run. Never sent to Jev. A failed capture is logged and never stops the run.
 */
export async function captureScreenshot(
  browser: Actor,
  recorder: Recorder,
  step: number,
  attempt: number,
  after: ScreenshotAfter,
  url: unknown,
): Promise<void> {
  if (process.env.WEBHAND_SCREENSHOTS !== "1" || !browser.screenshot) return;
  try {
    recorder.screenshot(step, attempt, after, await browser.screenshot(), url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recorder.event("screenshot_failed", { step, attempt, error: message });
  }
}

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

type OnChange = (page: Page) => void;

/** A step for the run log: the value's label instead of the typed text, and the URL without query values. */
function logged(step: HistoryEntry, region: unknown, values: Value[]): Record<string, unknown> {
  const { text, url, ...rest } = step;
  const entry: Record<string, unknown> = { ...rest, region: typeof region === "string" ? region : null };
  entry.url = safeUrl(url);
  entry.value = text === null ? null : (values.find((v) => v.value === text)?.label ?? null);
  if (text !== null) entry.text_chars = [...String(text)].length;
  return entry;
}

/** Runs once. Logged before the next observation so a navigation cannot erase it. */
export async function execute(
  browser: Actor,
  page: Page,
  decision: Decision,
  history: HistoryEntry[],
  recorder: Recorder,
  options: { decidedBy: string; attempt: number; onChange?: OnChange; values?: Value[]; knowledge?: Knowledge },
): Promise<Page> {
  const onChange = options.onChange ?? (() => {});
  const action = decision.action as Page;
  await browser.act(action, page, decision.text);
  const step: HistoryEntry = {
    step: history.length + 1,
    attempt: options.attempt,
    decided_by: options.decidedBy,
    confidence: decision.confidence,
    operation: decision.operation,
    kind: action.kind,
    action: action.label,
    text: decision.text,
    url: page.url,
    page_changed: null,
  };
  history.push(step);
  recorder.event("step", logged(step, action.region, options.values ?? []));
  onChange(page);
  const asked = browser.ignoredWindows ? await browser.ignoredWindows().catch(() => []) : [];
  const newPage = await browser.observe();
  step.page_changed = !samePage(newPage, page);
  recorder.event("step_result", { step: step.step, page_changed: step.page_changed });
  options.knowledge?.record({
    from: page.url,
    to: newPage.url,
    kind: action.kind,
    label: action.label,
    changed: step.page_changed,
  });
  if (asked.length) {
    recorder.event("window_ignored", { step: step.step, attempt: options.attempt, urls: asked.map(safeUrl) });
  }
  if (step.page_changed) recorder.event("page", pageEvent(newPage, options.attempt));
  await captureScreenshot(browser, recorder, step.step, options.attempt, "action", newPage.url);
  onChange(newPage);
  return newPage;
}

/**
 * v2: Jev chose an element beyond the viewport. It is scrolled into view (a scroll, never an input), the page
 * is observed again, and the same element with the same operation is taken from that observation. When it is
 * no longer offered, nothing runs: StalePage, as for any refused action.
 */
async function intoView(
  browser: Actor,
  page: Page,
  decision: Decision,
  recorder: Recorder,
  attempt: number,
): Promise<{ page: Page; decision: Decision }> {
  const action = decision.action as Action;
  await browser.act({ kind: "reveal", node: action.node, label: action.label }, page);
  const next = await browser.observe();
  const same = (next.actions ?? []).find(
    (a: Action) =>
      !a.offscreen && a.node === action.node && a.kind === action.kind && (a.value ?? null) === (action.value ?? null),
  );
  recorder.event("into_view", { attempt, at: action.at ?? null, found: Boolean(same) });
  if (!same) throw new StalePage("Target was not in view after scrolling to it", ["target_unreachable"]);
  const chosen = new Decision(decision.operation, same, { confidence: decision.confidence, text: decision.text });
  return { page: next, decision: chosen };
}

/** Markers are JSON values from the page; equal content means the same page. */
function sameMarker(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The same page in the same tab setup: a new or closed tab, or a switch, is a change even when the page is not. */
function samePage(a: Page, b: Page): boolean {
  return sameMarker(a.marker, b.marker) && sameMarker(a.tabs ?? null, b.tabs ?? null);
}

export interface AgentResult {
  outcome: string;
  detail: string | null;
  page: Page;
  actions: number;
  decisions: number;
  elapsed_ms: number;
  field?: Record<string, unknown>;
  /** Why Jev refused (JEV_FAILED), for the run log only. */
  jev?: Record<string, unknown>;
}

/** Runs one attempt until an outcome above. history is extended in place. */
export async function runAgent(
  browser: Actor,
  policy: Policy,
  plan: Plan,
  recorder: Recorder,
  budget: Budget = new Budget(),
  options: {
    history?: HistoryEntry[];
    page?: Page | null;
    decisions?: number;
    onChange?: OnChange;
    onDecision?: (count: number) => void;
    knowledge?: Knowledge;
  } = {},
): Promise<AgentResult> {
  const attempt = plan.attempt ?? 1;
  const history = options.history ?? [];
  const onChange = options.onChange ?? (() => {});
  const onDecision = options.onDecision ?? (() => {});
  let decisions = options.decisions ?? 0;
  const started = performance.now();
  let page = options.page || (await browser.observe());

  const flushCalls = () => {
    for (const call of policy.calls) recorder.call(call);
    policy.calls.length = 0;
  };

  const finish = (outcome: string, detail: string | null = null, extra: Partial<AgentResult> = {}): AgentResult => ({
    outcome,
    detail,
    page,
    actions: actionsIn(history, attempt).length,
    decisions,
    elapsed_ms: Math.round(performance.now() - started),
    ...extra,
  });

  while (true) {
    if (stuck(history, attempt)) return finish(STUCK, "three actions without a page change");
    if (plan.flow === "v2" && looping(history, attempt)) {
      return finish(STUCK, "scrolled up and down three times with nothing else done");
    }
    if (plan.flow === "v2" && missingInUnseen(history, page, attempt)) {
      return finish(STUCK, "the needed element was not offered twice, and the page has parts webhand cannot see");
    }
    if (actionsIn(history, attempt).length >= budget.maxActions || decisions >= budget.maxDecisions) {
      return finish(ATTEMPT_BUDGET, `${actionsIn(history, attempt).length} actions, ${decisions} decisions`);
    }
    let decision: Decision | null = null;
    const executed = history.length;
    try {
      if (!(await browser.fresh(page))) page = await browser.observe();
      decisions += 1;
      onDecision(decisions);
      decision = await policy.choose(page, plan, history);
      flushCalls();
      if (decision.operation === "NOT_VISIBLE") {
        const entry = {
          step: history.length + 1,
          attempt,
          operation: "NOT_VISIBLE",
          kind: MISSING,
          action: `Wanted to ${decision.wanted}, but the needed element was not listed. Nothing ran`,
          text: null,
          url: page.url,
          page_changed: false,
        };
        history.push(entry);
        recorder.event("not_visible", {
          attempt,
          wanted: decision.wanted,
          confidence: decision.confidence,
          offered: offered(page),
          ...(browser.unseen ? { unseen: await browser.unseen().catch(() => null) } : {}),
          ...(page.frames_log ? { frames: page.frames_log } : {}),
        });
        onChange(page);
        continue;
      }
      if (decision.action === null) {
        if (!(await browser.fresh(page))) continue;
        const outcome =
          ({ DONE: GOAL_REPORTED, NEEDS_HUMAN, ESCALATE } as Record<string, string>)[decision.operation] ?? BLOCKED;
        return finish(outcome, `Jev chose ${decision.operation}`);
      }
      if (decision.action.kind === "fill" && decision.text === null) {
        const field: Record<string, unknown> = {};
        for (const key of ["label", "role", "value"]) field[key] = decision.action[key] ?? null;
        return finish(NEEDS_VALUE, "no value from the plan fits this field", { field });
      }
      if (decision.action.offscreen) ({ page, decision } = await intoView(browser, page, decision, recorder, attempt));
      page = await execute(browser, page, decision, history, recorder, {
        decidedBy: policy.name,
        attempt,
        onChange,
        values: plan.values,
        knowledge: options.knowledge,
      });
    } catch (error) {
      if (error instanceof StalePage) {
        const observed = page;
        page = await browser.observe();
        // Only a refused action is noted. A step that ran is already in history, whatever failed after it.
        if (decision !== null && decision.action !== null && history.length === executed) {
          const entry = {
            step: history.length + 1,
            attempt,
            operation: "STALE",
            kind: STALE,
            action: `${decision.operation} ${quote(decision.action.label)} did not run: ${error.message}`,
            text: null,
            url: observed.url,
            // Unchanged: the same choice would be refused again, so it counts toward STUCK.
            page_changed: !samePage(page, observed),
          };
          history.push(entry);
          recorder.event("stale", {
            attempt,
            wanted: decision.operation,
            target: decision.action.label,
            reason: error.message,
            changed: error.changed,
            page_changed: entry.page_changed,
          });
        }
        onChange(page);
      } else if (error instanceof PolicyError) {
        return finish(JEV_FAILED, error.message, error.diagnostic ? { jev: error.diagnostic } : {});
      } else if (error instanceof MutationUncertain) {
        return finish(UNCERTAIN, `mutation uncertain: ${error.message}`);
      } else {
        throw error;
      }
    } finally {
      flushCalls();
    }
  }
}
