/** Single-step execution, offscreen reveal, telemetry (page_check, screenshots), and history logging. */

import { quote } from "../core/format.ts";
import { pageEvent, type Recorder, type ScreenshotAfter, safeUrl } from "../core/metrics.ts";
import { type Action, Decision, type HistoryEntry, type Page, StalePage, type Value } from "../core/types.ts";
import type { SiteMemory } from "../storage/memory.ts";
import { samePage } from "./guards.ts";
import { type Actor, MISSING, STALE } from "./outcomes.ts";

export type OnChange = (page: Page) => void;

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
  options: { decidedBy: string; attempt: number; onChange?: OnChange; values?: Value[]; memory?: SiteMemory },
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
  const downloads = browser.takeDownloads?.() ?? [];
  if (downloads.length) step.downloads = downloads;
  history.push(step);
  recorder.event("step", logged(step, action.region, options.values ?? []));
  onChange(page);
  const asked = browser.ignoredWindows ? await browser.ignoredWindows().catch(() => []) : [];
  const newPage = await browser.observe();
  step.page_changed = !samePage(newPage, page);
  recorder.event("step_result", { step: step.step, page_changed: step.page_changed });
  options.memory?.record({
    from: page.url,
    to: newPage.url,
    kind: action.kind,
    label: action.label,
    changed: step.page_changed,
    inItem: page.guards?.[String(action.node)]?.[14] === "item",
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
 * is observed again, and the same element with the same operation is taken from that observation.
 */
export async function intoView(
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

/** Jev said the element it needs was not listed: noted in the history and the log. Nothing ran. */
export async function noteNotVisible(
  browser: Actor,
  recorder: Recorder,
  history: HistoryEntry[],
  page: Page,
  decision: Decision,
  attempt: number,
): Promise<void> {
  history.push({
    step: history.length + 1,
    attempt,
    operation: "NOT_VISIBLE",
    kind: MISSING,
    action: `Wanted to ${decision.wanted}, but the needed element was not listed. Nothing ran`,
    text: null,
    url: page.url,
    page_changed: false,
  });
  recorder.event("not_visible", {
    attempt,
    wanted: decision.wanted,
    confidence: decision.confidence,
    offered: offered(page),
    ...(browser.unseen ? { unseen: await browser.unseen().catch(() => null) } : {}),
    ...(page.frames_log ? { frames: page.frames_log } : {}),
  });
}

/** An action refused as stale is noted. Unchanged, the same choice would be refused again, so it counts toward STUCK. */
export function noteRefused(
  recorder: Recorder,
  history: HistoryEntry[],
  decision: Decision & { action: Action },
  error: StalePage,
  observed: Page,
  now: Page,
  attempt: number,
): void {
  const entry = {
    step: history.length + 1,
    attempt,
    operation: "STALE",
    kind: STALE,
    action: `${decision.operation} ${quote(decision.action.label)} did not run: ${error.message}`,
    text: null,
    url: observed.url,
    page_changed: !samePage(now, observed),
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
