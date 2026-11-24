/** Helpers shared by commands: session lookup, attaching to the session's engine, opening pages, and explore findings. */

import { join } from "node:path";
import * as agent from "../agent/index.ts";
import { Browser, type ViewChoice } from "../browser/index.ts";
import { stamp } from "../core/format.ts";
import { Recorder } from "../core/metrics.ts";
import { PolicyError, type Value } from "../core/types.ts";
import * as workspace from "../core/workspace.ts";
import { chooseChrome as pickChrome } from "../engines/chrome.ts";
import { engineFor } from "../engines/index.ts";
import { dedupe, type Finding, isDeadEnd, plainUrl } from "../explore.ts";
import type { Driver } from "../ipc/remote.ts";
import * as session from "../storage/session.ts";
import { CliExit, getContext } from "./context.ts";

export { mergeValues, parseFiles, parseSteps, parseValues, resolveCliUrl } from "./validation.ts";

export function chooseChrome(choice: string): [string, string | null] {
  try {
    return pickChrome(choice);
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
}

/** What a log may name for the values and files of a plan: labels, never the text or the path. */
export function loggable(plan: { values: Value[]; files?: Value[] }): Value[] {
  return [...plan.values, ...(plan.files ?? [])];
}

export function requireSession(): session.State {
  const state = session.load();
  if (state === null) throw new CliExit("No active session. Run: webhand start");
  getContext().log = state.log;
  return state;
}

/** Connects to the session's browser via its engine's attach implementation. Opens url when given. */
export async function attach(state: session.State, url: string | null, view?: ViewChoice | null): Promise<Driver> {
  const engineId = state.engine ?? (state.cdp ? "browser-run" : state.socket ? "lightpanda" : "chrome");
  return await engineFor(engineId).attach(state, url, view);
}

export async function openPage(
  state: session.State,
  url: string | null = null,
  restart = false,
  read: string[] = [],
): Promise<void> {
  const view = browserView(state);
  // `read` is for this observation only: the session's saved view is not changed.
  const browser = await attach(
    state,
    url,
    read.length ? { ...(view ?? {}), read: [...(view?.read ?? []), ...read] } : view,
  );
  try {
    state.page = await browser.observe();
    if (restart && process.env.WEBHAND_SCREENSHOTS === "1") {
      const recorder = new Recorder(state.log);
      try {
        await agent.captureScreenshot(
          browser,
          recorder,
          state.history.length,
          state.plan.attempt,
          "restart",
          state.page.url,
        );
      } finally {
        recorder.close();
      }
    }
  } finally {
    await browser.close();
  }
  session.save(state);
}

export function attemptLabel(state: session.State): string {
  return `attempt ${state.plan.attempt}/${state.max_attempts}`;
}

export function defaultLog(name: string): string {
  return process.env.WEBHAND_LOG || join(workspace.home(), "runs", stamp(), `${name}.jsonl`);
}

/** Why Jev refused, for the run log only. */
export function jevDiagnostic(error: Error): { jev?: Record<string, unknown> } {
  return error instanceof PolicyError && error.diagnostic ? { jev: error.diagnostic } : {};
}

/** The snapshot's view: saved and Claude's regions, and with flow v2, the whole page. */
export function browserView(state: session.State): ViewChoice | null {
  const view = (state.view ?? null) as ViewChoice | null;
  return state.plan?.flow === "v2" ? { ...(view ?? {}), whole: true } : view;
}

export const FLOWS = ["v1", "v2"];

/** Actions left for an exploring session as a whole; null when the session is not exploring. */
export function exploreActionsLeft(state: session.State): number | null {
  if (!state.explore) return null;
  return Math.max(0, state.explore.max_total - agent.executed(state.history).length);
}

/**
 * Exploring: writes what the browser noted since the last command, and a dead end if the page offers nothing to do,
 * to the log as `finding` events, each with the step it followed. Counts and clipped text only.
 */
export function recordFindings(state: session.State, browser: Driver, recorder: Recorder): void {
  if (!state.explore) return;
  const step = agent.executed(state.history).length;
  const noted: Finding[] = browser instanceof Browser ? browser.takeFindings() : [];
  if (isDeadEnd(state.page)) noted.push({ signal: "dead_end", url: plainUrl(state.page.url ?? ""), detail: "" });
  for (const finding of dedupe(noted)) {
    recorder.event("finding", {
      signal: finding.signal,
      url: finding.url,
      detail: finding.detail,
      ...(finding.status ? { status: finding.status } : {}),
      step,
    });
  }
}
