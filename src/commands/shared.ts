/** Helpers more than one command uses: values and steps, the session, attaching to the browser, opening a page. */

import { realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import * as agent from "../agent.ts";
import { Browser, type ViewChoice } from "../browser.ts";
import { browserRunHeaders } from "../engines/cloudflare.ts";
import { dedupe, type Finding, isDeadEnd, plainUrl } from "../explore.ts";
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

/** Whether child is inside parent (or is it). Both real paths. */
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * --file LABEL=PATH: a file the run may upload. Only a file under the current directory, never the saved logins
 * or an .env, so a plan cannot send the machine's secrets to a page. The path is made absolute and real here.
 */
export function parseFiles(pairs: string[]): Value[] {
  return parseValues(pairs.map((pair) => pair.replace(/^--file=/, ""))).map(({ label, value }) => {
    let real: string;
    try {
      real = realpathSync(resolve(value));
      if (!statSync(real).isFile()) throw new Error("not a file");
    } catch {
      throw new CliExit(`--file ${quote(label)}: ${quote(value)} is not a file`);
    }
    if (!inside(realpathSync(process.cwd()), real)) {
      throw new CliExit(`--file ${quote(label)}: only files under the current directory can be uploaded`);
    }
    if (inside(resolve(workspace.stateHome()), real) || inside(realOrResolved(workspace.stateHome()), real)) {
      throw new CliExit(`--file ${quote(label)}: webhand's saved state cannot be uploaded`);
    }
    if (basename(real).startsWith(".env")) throw new CliExit(`--file ${quote(label)}: an .env file cannot be uploaded`);
    return { label, value: real };
  });
}

/** What a log may name for the values and files of a plan: labels, never the text or the path. */
export function loggable(plan: { values: Value[]; files?: Value[] }): Value[] {
  return [...plan.values, ...(plan.files ?? [])];
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
  state: { port?: number; socket?: string; cdp?: string; download_dir?: string; explore?: { allow: string[] } | null },
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
  return await Browser.open(url, {
    port: state.port,
    view,
    downloadDir: state.download_dir ?? null,
    explore: state.explore ?? null,
  });
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
