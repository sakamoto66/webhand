/** Helpers more than one command uses: values and steps, the session, attaching to the browser, opening a page. */

import { join } from "node:path";
import * as agent from "../agent.ts";
import { Browser, type ViewChoice } from "../browser.ts";
import { browserRunHeaders } from "../engines/cloudflare.ts";
import { quote, stamp } from "../format.ts";
import { Recorder } from "../metrics.ts";
import { type Driver, RemoteBrowser } from "../remote.ts";
import * as session from "../session.ts";
import { PolicyError, type Step, type Value } from "../types.ts";
import * as workspace from "../workspace.ts";

import { CliExit, getContext } from "./context.ts";

const PERSON = "[person]";

export function parseValues(pairs: string[]): Value[] {
  return pairs.map((pair) => {
    const at = pair.indexOf("=");
    const label = at < 0 ? "" : pair.slice(0, at).trim();
    if (at < 0 || !label) throw new CliExit(`Expected --value LABEL=VALUE, got ${quote(pair)}`);
    return { label, value: pair.slice(at + 1) };
  });
}

export function mergeValues(current: Value[], added: Value[]): Value[] {
  const merged = new Map(current.map((value) => [value.label, value]));
  for (const value of added) merged.set(value.label, value);
  return [...merged.values()];
}

/** A step written as "[person] Sign in" is one a person does in the window. */
export function parseSteps(texts: string[]): Step[] {
  return texts.map((text) => {
    const human = text.startsWith(PERSON);
    return { actor: human ? "human" : "jev", instruction: (human ? text.slice(PERSON.length) : text).trim() };
  });
}

export function requireSession(): session.State {
  const state = session.load();
  if (state === null) throw new CliExit("No active session. Run: webhand start");
  getContext().log = state.log;
  return state;
}

/** The session's browser: Chrome by CDP port, or the daemon that holds an engine's page (Lightpanda, Obscura) by socket. Opens url when given. */
export async function attach(
  state: { port?: number; socket?: string; cdp?: string },
  url: string | null,
  view?: ViewChoice | null,
): Promise<Driver> {
  if (state.cdp) {
    return await Browser.open(url, { endpoint: { url: state.cdp, headers: browserRunHeaders() }, view });
  }
  if (state.socket) {
    const remote = await RemoteBrowser.connect(state.socket, view ?? null);
    try {
      if (url) await remote.goto(url);
    } catch (error) {
      await remote.close();
      throw error;
    }
    return remote;
  }
  return await Browser.open(url, { port: state.port, view });
}

export async function openPage(state: session.State, url: string | null = null, restart = false): Promise<void> {
  const browser = await attach(state, url, browserView(state));
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

/** A URL replan may open: http, https, or file. */
export function openableUrl(url: string): boolean {
  try {
    return ["http:", "https:", "file:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Why Jev refused, for the run log only. */
export function jevDiagnostic(error: Error): { jev?: Record<string, unknown> } {
  return error instanceof PolicyError && error.diagnostic ? { jev: error.diagnostic } : {};
}

/** The snapshot's view: learned and Claude's regions, and with flow v2, the whole page. */
export function browserView(state: session.State): ViewChoice | null {
  const view = (state.view ?? null) as ViewChoice | null;
  return state.plan?.flow === "v2" ? { ...(view ?? {}), whole: true } : view;
}

export const FLOWS = ["v1", "v2"];
