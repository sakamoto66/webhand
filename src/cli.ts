/**
 * CLI for the Claude + Jev agent. Each call is one short process.
 *
 * Claude plans the goal, steps, and values, reviews the outcome, and replans. Jev chooses every
 * operation toward the goal and hands control back only when it cannot continue on its own.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as agent from "./agent.ts";
import { Budget, execute, runAgent } from "./agent.ts";
import { type Args, type CommandSpec, type OptionSpec, type Parsed, parse as parseArgs } from "./args.ts";
import * as auth from "./auth.ts";
import { Browser, type ViewChoice } from "./browser.ts";
import { type Collector, collectScan } from "./collect.ts";
import { type Comparer, compareScan, type Reader } from "./compare.ts";
import { browserUrl, CHROMES, listProfiles, chooseChrome as pickChrome, profileDir } from "./engines/chrome.ts";
import { browserRunHeaders } from "./engines/cloudflare.ts";
import { chooseEngine, ENGINE_CHOICES, engineFor, hostName } from "./engines/index.ts";
import { describeError, quote, show, stamp, toJson } from "./format.ts";
import { Knowledge } from "./knowledge.ts";
import * as learn from "./learn.ts";
import { gitState, logOnce, maskUrls, pageEvent, Recorder, safeUrl, summarize } from "./metrics.ts";
import { loadMore, type MoreChooser } from "./more.ts";
import { collectedLine, comparedLine, describePlan, headline, recentActions, render } from "./output.ts";
import { planText, resolve } from "./policies/base.ts";
import { JevPolicy } from "./policies/jev.ts";
import { type Driver, RemoteBrowser } from "./remote.ts";
import * as runbook from "./runbook.ts";
import * as session from "./session.ts";
import {
  type HistoryEntry,
  type ModelCall,
  MutationUncertain,
  type Page,
  type Plan,
  type Policy,
  PolicyError,
  StalePage,
  type Step,
  type Value,
  type Verdict,
} from "./types.ts";
import * as workspace from "./workspace.ts";

export const OK = 0;
export const FAILED = 1;
const STALE = 3;
export const UNCERTAIN = 4;
export const BUDGET = 5;
const DEFAULT_ATTEMPTS = 3;
const PERSON = "[person]";

/** What a command needs to stop with a message, on stderr with exit code 1. */
export class CliExit extends Error {
  override name = "CliExit";
}

/** What tests replace: Jev, and how Chrome starts. */
export const deps = {
  policy: (): Policy & { close?(): Promise<void> } => new JevPolicy(),
  startChrome: session.startChrome,
};

/**
 * What a caller outside the CLI may add. The research wrapper (research/webhand.ts) labels a run with its
 * task and verifies it at finish; the shipped CLI passes none.
 */
export interface Hooks {
  /** Recorded as the run's task and used to name its log. */
  task?: string;
  /** Checks the final page before Chrome closes. */
  verify?: (browser: Browser, state: session.State) => Promise<Verdict>;
}

interface Context {
  out: string[];
  err: (text: string) => void;
  log: string | null;
  hooks: Hooks;
}

let context: Context = { out: [], err: () => {}, log: null, hooks: {} };

function print(text = ""): void {
  context.out.push(`${named(text)}\n`);
}

/** Commands Claude is told to run next carry the session's --id, so a second session is not mixed up with the first. */
function named(text: string): string {
  const id = session.id();
  if (id === session.DEFAULT_ID) return text;
  return text
    .replace(/\b(finish|run) (?=--(?:status|human-done|value)\b)/g, `$1 --id ${id} `)
    .replace(/\bwebhand (start|run|replan|finish|act|observe)\b(?! --)/g, `webhand $1 --id ${id}`);
}

/** Runs fn and returns what it printed. For tests of the output Claude reads. */
export function captured<T>(fn: () => T): { result: T; text: string } {
  const saved = context;
  context = { out: [], err: saved.err, log: null, hooks: {} };
  try {
    const result = fn();
    return { result, text: context.out.join("") };
  } finally {
    context = saved;
  }
}

// --- Plan and session state ----------------------------------------------------------------

function parseValues(pairs: string[]): Value[] {
  return pairs.map((pair) => {
    const at = pair.indexOf("=");
    const label = at < 0 ? "" : pair.slice(0, at).trim();
    if (at < 0 || !label) throw new CliExit(`Expected --value LABEL=VALUE, got ${quote(pair)}`);
    return { label, value: pair.slice(at + 1) };
  });
}

function mergeValues(current: Value[], added: Value[]): Value[] {
  const merged = new Map(current.map((value) => [value.label, value]));
  for (const value of added) merged.set(value.label, value);
  return [...merged.values()];
}

/** A step written as "[person] Sign in" is one a person does in the window. */
function parseSteps(texts: string[]): Step[] {
  return texts.map((text) => {
    const human = text.startsWith(PERSON);
    return { actor: human ? "human" : "jev", instruction: (human ? text.slice(PERSON.length) : text).trim() };
  });
}

function requireSession(): session.State {
  const state = session.load();
  if (state === null) throw new CliExit("No active session. Run: webhand start");
  context.log = state.log;
  return state;
}

/** The session's browser: Chrome by CDP port, or the daemon that holds an engine's page (Lightpanda, Obscura) by socket. Opens url when given. */
async function attach(
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

async function openPage(state: session.State, url: string | null = null, restart = false): Promise<void> {
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

function attemptLabel(state: session.State): string {
  return `attempt ${state.plan.attempt}/${state.max_attempts}`;
}

function defaultLog(name: string): string {
  return process.env.WEBHAND_LOG || join(workspace.home(), "runs", stamp(), `${name}.jsonl`);
}

// --- Commands ------------------------------------------------------------------------------

/** A URL replan may open: http, https, or file. */
function openableUrl(url: string): boolean {
  try {
    return ["http:", "https:", "file:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Why Jev refused, for the run log only. */
function jevDiagnostic(error: Error): { jev?: Record<string, unknown> } {
  return error instanceof PolicyError && error.diagnostic ? { jev: error.diagnostic } : {};
}

/** The snapshot's view: learned and Claude's regions, and with flow v2, the whole page. */
function browserView(state: session.State): ViewChoice | null {
  const view = (state.view ?? null) as ViewChoice | null;
  return state.plan?.flow === "v2" ? { ...(view ?? {}), whole: true } : view;
}

/** Everything learned, for Claude to plan from. */
async function commandCatalog(args: Args): Promise<number> {
  const project = workspace.projectRoot();
  const projectRunbooks = runbook.root("project");
  print(`RUNBOOKS (project) ${projectRunbooks}${project ? "" : " (not created)"}`);
  print(`RUNBOOKS (user) ${runbook.root("user")}`);
  let services: runbook.CatalogEntry[];
  try {
    services = runbook.catalog();
  } catch (error) {
    if (error instanceof runbook.RunbookError) throw new CliExit(error.message);
    throw error;
  }
  if (!services.length) print("NOTHING LEARNED. Plan from the request, or teach a service with /webhand-learn");
  for (const entry of services) {
    const info = entry.info;
    print(`SERVICE ${entry.service}${info ? ` (${info.scope})` : ""}`);
    if (info) {
      print(`  ${info.description}\n  base_url: ${info.base_url}`);
      const login = info.login;
      print(`  login: ${login.required ? "required" : "not required"}${login.url ? ` (${login.url})` : ""}`);
      for (const page of info.pages) {
        print(`  page: ${page.url} — ${page.purpose}`);
        for (const region of page.regions) {
          const fallback = region.default ? ` [${region.default}]` : "";
          print(`    region ${region.key}${fallback}: ${region.purpose}`);
        }
      }
      for (const fact of info.facts) print(`  fact: ${fact}`);
    } else {
      print("  (no service.toml)");
    }
    for (const procedure of entry.procedures) {
      print(`  PROCEDURE ${procedure.name} [${show(procedure.status)}] (${procedure.scope}): ${show(procedure.goal)}`);
      print(`    start_url: ${show(procedure.start_url)}`);
      for (const [key, description] of Object.entries(procedure.params)) print(`    param ${key}: ${description}`);
      if (procedure.human_steps) print(`    human steps: ${procedure.human_steps} (needs --headed)`);
      for (const key of ["focus", "skip"] as const) {
        if (procedure[key]?.length) print(`    ${key}: ${procedure[key].join(", ")}`);
      }
    }
  }
  const [chrome, note] = chooseChrome(args.chrome);
  const profiles = listProfiles(chrome);
  print(`CHROME: ${chrome}${note ? ` (${note})` : ""}`);
  print(`SAVED PROFILES: ${profiles.length ? profiles.join(", ") : "(none)"}`);
  const open = session.active();
  if (open.length) {
    print("ACTIVE SESSIONS (use --id on every command of one):");
    for (const [id, state] of open) print(`  ${id}: ${quote(String(state.plan?.goal ?? "").slice(0, 80))}`);
  }
  return OK;
}

function chooseChrome(choice: string): [string, string | null] {
  try {
    return pickChrome(choice);
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
}

/** What `start` resolves from its arguments before anything is opened. */
interface StartTarget {
  book: runbook.Runbook | null;
  service: runbook.ServiceInfo | null;
  serviceName: string | null;
  /** The saved profile, or null for a new session. */
  profile: string | null;
  /** Where Chrome runs, and the note for the person when auto fell back. */
  chrome: string;
  note: string | null;
  engine: string;
  login: auth.SavedLogin | null;
}

/** The runbook, service, saved login, engine and Chrome the arguments ask for. Nothing is opened. */
function resolveTarget(args: Args): StartTarget {
  try {
    let book: runbook.Runbook | null = null;
    if (args.runbook) {
      book = runbook.load(args.runbook, runbook.parseValues(args.param));
      if (book.status !== "approved" && !args.allow_draft) {
        throw new CliExit(`Runbook ${args.runbook} is a draft. Trial it with --allow-draft, then get it approved`);
      }
    }
    const serviceName = args.service || (book ? book.service : null);
    const service = serviceName ? runbook.loadService(serviceName) : null;
    const profile = session.parseSession(args.session);
    const login = args.auth ? loadLogin(args.auth, profile) : null;
    const engine = chooseEngine(args.engine, { headed: args.headed, profile, chrome: args.chrome });
    // --chrome says where Chrome runs; the other engines have no such choice.
    const [chrome, note] = engine === "chrome" ? pickChrome(args.chrome) : ["linux", null];
    return { book, service, serviceName, profile, chrome, note, engine, login };
  } catch (error) {
    if (error instanceof runbook.RunbookError || error instanceof session.SessionError) {
      throw new CliExit(error.message);
    }
    throw error;
  }
}

/** The saved login --auth names. It is for a new session: a saved profile already keeps its own sign-in. */
function loadLogin(name: string, profile: string | null): auth.SavedLogin {
  if (profile) throw new CliExit("--auth is for a new session: a saved profile already keeps its own sign-in");
  auth.checkName(name);
  if (!auth.exists(name)) {
    const known = auth.names();
    throw new CliExit(
      `No saved login ${name}. Saved: ${known.length ? known.join(", ") : "(none)"}. Save one with: webhand auth save NAME`,
    );
  }
  return auth.load(name);
}

/** The goal, start URL, steps and values for the run, checked before a browser is started. */
function planStart(args: Args, target: StartTarget): { plan: Plan; goal: string; url: string; values: Value[] } {
  const { book, service } = target;
  const goal: string | null = args.goal || (book ? book.goal : null);
  const url: string | null = args.url || (book ? book.start_url : null);
  if (!(goal && url)) throw new CliExit("Give --runbook, or both --goal and --url");
  let steps: Step[] = [];
  if (args.step.length) steps = parseSteps(args.step);
  else if (book) steps = book.steps;
  let values = parseValues(args.value);
  if (book) {
    // Runbook parameters are Claude's values too, unless Claude labelled them itself.
    const params = Object.entries(runbook.parseValues(args.param)).map(([label, value]) => ({ label, value }));
    values = mergeValues(params, values);
  }
  if (steps.some((step) => step.actor === "human") && !args.headed) {
    throw new CliExit("This plan has [person] steps. Add --headed so the person can see the window");
  }
  if (!FLOWS.includes(args.flow)) throw new CliExit(`WEBHAND_FLOW must be one of: ${FLOWS.join(", ")}`);
  if (!process.env.TYPESAFE_API_KEY) {
    throw new CliExit("TYPESAFE_API_KEY is not set. Set it as an environment variable");
  }
  const plan: Plan = {
    goal,
    steps,
    values,
    notes: [],
    attempt: 1,
    service: service ? { description: service.description, facts: service.facts } : null,
    ...(args.compare ? { compare: args.compare } : {}),
    ...(args.collect ? { collect: args.collect } : {}),
    ...(args.more ? { more: args.more } : {}),
    ...(args.flow === "v2" ? { flow: "v2" as const } : {}),
  };
  if (plan.compare && plan.collect) throw new CliExit("Use --compare or --collect, not both");
  if (plan.more && !plan.compare && !plan.collect) throw new CliExit("--more needs --compare or --collect");
  return { plan, goal, url, values };
}

/** The session state `start` saves: the browser's, the run's limits, and what Claude and the service taught it. */
function initialState(
  args: Args,
  target: StartTarget,
  planned: { plan: Plan; url: string },
  chromeState: session.State,
): session.State {
  const { book, service, serviceName, chrome } = target;
  const task = context.hooks.task ?? null;
  const learned = runbook.view(runbook.serviceView(service), book);
  const claudeView = { focus: args.focus, skip: args.skip, read: args.read };
  return {
    ...chromeState,
    view_learned: learned,
    view_claude: claudeView,
    view: runbook.view(learned, claudeView),
    task,
    start_url: browserUrl(planned.url, chrome),
    plan: planned.plan,
    runbook: book ? { name: book.name, status: book.status, digest: book.digest, scope: book.scope } : null,
    service: serviceName,
    history: [],
    decisions: 0,
    attempt_decisions: 0,
    outcome: null,
    outcomes: [],
    max_attempts: args.max_attempts,
    max_actions: args.max_actions,
    max_decisions: args.max_decisions,
    started: Date.now() / 1000,
    log: defaultLog(task || "adhoc"),
  };
}

/**
 * Opens the start page (restoring the saved login first), observes it, and records the start in the log. A failed
 * start is a run too: it keeps why it failed, and the browser is stopped. Returns the sites whose localStorage a
 * saved login could not restore.
 */
async function openStartPage(
  args: Args,
  target: StartTarget,
  planned: { plan: Plan; goal: string; values: Value[] },
  chromeState: session.State,
  state: session.State,
): Promise<string[]> {
  const { book, serviceName, profile, chrome, engine, login } = target;
  const { plan, goal, values } = planned;
  const recorder = new Recorder(state.log);
  let browser: Driver | null = null;
  let skipped: string[] = [];
  try {
    if (login) {
      browser = await attach(chromeState, null, browserView(state));
      skipped = await browser.restore(login.state, state.start_url);
    } else {
      browser = await attach(chromeState, state.start_url, browserView(state));
    }
    state.page = await browser.observe();
    recorder.event("run_start", {
      task: state.task,
      goal,
      chrome: browser.version,
      chrome_host: chrome,
      ...(engine !== "chrome" ? { engine } : {}),
      session: profile ? "profile" : "new",
      ...(args.auth ? { auth: args.auth } : {}),
      git: gitState(),
      runbook: state.runbook,
      service: serviceName,
      view: state.view,
      ...(plan.flow ? { flow: plan.flow } : {}),
      max_attempts: args.max_attempts,
      started_at: new Date().toISOString(),
    });
    recorder.event("plan", {
      attempt: 1,
      steps: planText(plan),
      values: values.map((v) => v.label),
      view: state.view,
      ...(plan.compare ? { compare: plan.compare } : {}),
      ...(plan.collect ? { collect: plan.collect } : {}),
      ...(plan.more ? { more: plan.more } : {}),
      source: book && !args.step.length ? "runbook" : "claude",
    });
    recorder.event("page", pageEvent(state.page, 1));
    await agent.checkPage(browser, recorder, "start", 1, state.page.url);
    await agent.captureScreenshot(browser, recorder, 0, 1, "start", state.page.url);
  } catch (error) {
    recorder.event("start_failed", {
      error: maskUrls(describeError(error).split("\n")[0]),
      url: safeUrl(state.start_url),
      chrome_host: chrome,
      ...(engine !== "chrome" ? { engine } : {}),
      session: profile ? "profile" : "new",
      started_at: new Date().toISOString(),
    });
    await session.stopChrome(chromeState);
    throw error;
  } finally {
    await browser?.close();
    recorder.close();
  }
  return skipped;
}

/** What `start` tells the person once the page is open. */
function printStarted(args: Args, target: StartTarget, plan: Plan, state: session.State, skipped: string[]): void {
  const { note, engine, chrome } = target;
  const engineNotes = engineFor(engine).notes;
  if (note) print(`NOTE: ${note}`);
  if (engineNotes?.start) print(`NOTE: ${engineNotes.start}`);
  if (args.auth) {
    print(`SIGNED IN with saved login ${args.auth}. Pages opened signed in are sent to Jev`);
    if (engineNotes?.auth) print(`NOTE: ${engineNotes.auth}`);
    if (skipped.length) print(`NOTE: localStorage of other sites was not restored: ${skipped.join(", ")}`);
  }
  print(
    `${describePlan(plan, state.view)}\nSESSION: ${args.session} (${hostName(engine, chrome)})\n${headline(state.page)}`,
  );
  print("NEXT: webhand run");
}

async function commandStart(args: Args): Promise<number> {
  if (session.load()) {
    throw new CliExit(named("A session is active. Run: webhand finish --status abandoned, or start another with --id"));
  }
  const target = resolveTarget(args);
  const planned = planStart(args, target);
  let chromeState: session.State;
  try {
    chromeState = await deps.startChrome({
      headed: args.headed,
      profile: target.profile,
      chrome: target.chrome,
      engine: target.engine,
    });
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
  const state = initialState(args, target, planned, chromeState);
  context.log = state.log;
  const skipped = await openStartPage(args, target, planned, chromeState, state);
  session.save(state);
  printStarted(args, target, planned.plan, state, skipped);
  return OK;
}

/** Outcomes after which `answer` continues the same attempt (v2). */
const ANSWERABLE: string[] = [agent.ESCALATE, agent.STUCK, agent.BLOCKED, agent.GOAL_REPORTED, agent.JEV_FAILED];

/** v2: parts of the page webhand cannot see into, said plainly so that Claude looks for another way. */
function unseenHint(page: Page): string {
  if (!agent.unseenParts(page)) return "";
  const unseen = (page.status?.unseen ?? {}) as Record<string, number>;
  return (
    `. The page has ${unseen.canvases ?? 0} canvas, ${unseen.frames ?? 0} frame, and ${unseen.objects ?? 0} plugin parts ` +
    "whose content webhand cannot see: what Jev needs may be inside one. Answering cannot reveal it; look for another way " +
    "(a list or text version, another page, a keyboard route) or ask the person"
  );
}

/** Why the run came back, from the log of this attempt only. No page text. */
function diagnose(state: session.State, outcome: string): string {
  const status = state.page?.status as { kind?: string } | undefined;
  if (status?.kind === "check") return "the page is a bot check or CAPTCHA; a person must pass it";
  if (status?.kind === "sign_in") return "the page asks for a sign-in; a person must sign in";
  if (status?.kind === "error") return "the page is an error page";
  if (status?.kind === "dialog") return "a dialog covers the page";
  const rows = (state.history as HistoryEntry[]).filter((h) => (h.attempt ?? 1) === state.plan.attempt).slice(-3);
  const count = (kind: string) => rows.filter((h) => h.kind === kind).length;
  if (outcome === agent.STUCK) {
    if (agent.looping(state.history as HistoryEntry[], state.plan.attempt)) {
      return "Jev scrolled up and down three times and chose nothing: what it needs may not be on this page, or is elsewhere on it";
    }
    if (count("stale")) return "the last choices were refused as stale: the page keeps changing under the target";
    if (count("missing")) return `Jev could not find the element it needs in what was offered${unseenHint(state.page)}`;
    return "the last three actions did not change the page";
  }
  if (outcome === agent.GOAL_REPORTED) return "Jev thinks the goal is met and asks Claude to check the page";
  if (outcome === agent.JEV_FAILED) return "Jev gave no usable decision; nothing was executed";
  const handed =
    "Jev handed the decision to Claude: the page is not what the plan expects, nothing offered fits, or the operation cannot be undone";
  return `${handed}${unseenHint(state.page)}`;
}

/** What Claude needs for this outcome, and nothing more. */
export function report(state: session.State, result: agent.AgentResult): number {
  const outcome = result.outcome;
  print(`OUTCOME ${outcome} (${attemptLabel(state)}): ${show(result.detail)}`);
  if (outcome === agent.UNCERTAIN) {
    print("Do not repeat or replan. Run: webhand finish --status error");
    return UNCERTAIN;
  }
  if (outcome === agent.NEEDS_HUMAN) {
    print(`${headline(state.page)}\nAsk the person to do this in the Chrome window, then: run --human-done`);
    return OK;
  }
  if (outcome === agent.NEEDS_VALUE) {
    print(`FIELD: ${toJson(result.field)}`);
    print("Give the value with: run --value 'LABEL=VALUE'. Never invent personal data; ask the person");
    return OK;
  }
  print(`${recentActions(state)}\n${render(state.page)}`);
  if (state.plan.flow === "v2" && ANSWERABLE.includes(outcome)) {
    print(`WHY: ${diagnose(state, outcome)}`);
    print(
      "NEXT: answer --note '...' [--value 'LABEL=VALUE'] [--url URL] continues this attempt; replan changes the plan; " +
        "if it cannot be done, ask the person with AskUserQuestion; finish",
    );
    return OK;
  }
  if (outcome === agent.GOAL_REPORTED) {
    print("Check the page against the goal. If it is met: finish --status done. Otherwise: replan");
  } else if (outcome === agent.JEV_FAILED) {
    print("Nothing was executed. Run again, replan, or act");
  } else {
    print("NEXT: replan --reason '...' [--restart], act, or finish");
  }
  return OK;
}

/** Jev works toward the goal until it needs Claude or a person. */
/** Why `run` cannot go on from the state's last outcome, as the exit code after saying so. null when it can. */
function rejectRun(args: Args, state: session.State): number | null {
  const outcome = state.outcome;
  if (outcome === agent.UNCERTAIN) {
    print("REJECTED: the last action may have happened. Run: webhand finish --status error");
    return UNCERTAIN;
  }
  if (outcome === agent.NEEDS_HUMAN && !args.human_done) {
    print("REJECTED: a person is acting. When they are done: run --human-done");
    return FAILED;
  }
  if (outcome === agent.NEEDS_VALUE && !args.value.length) {
    print("REJECTED: this field needs run --value 'LABEL=VALUE'");
    return FAILED;
  }
  if ([agent.GOAL_REPORTED, agent.BLOCKED, agent.STUCK, agent.ATTEMPT_BUDGET, agent.ESCALATE].includes(outcome)) {
    print(
      `REJECTED: the attempt ended with ${outcome}. Run ${state.plan.flow === "v2" ? "answer, " : ""}replan, act, or finish`,
    );
    return FAILED;
  }
  return null;
}

/** Takes in what the person or Claude brought to this `run`: values, and a person's finished step. null when accepted. */
async function acceptRunInputs(args: Args, state: session.State): Promise<number | null> {
  if (args.value.length) {
    state.plan.values = mergeValues(state.plan.values, parseValues(args.value));
    logOnce(state.log, "values", {
      attempt: state.plan.attempt,
      labels: parseValues(args.value).map((v) => v.label),
    });
  }
  if (args.human_done) {
    if (state.outcome !== agent.NEEDS_HUMAN) {
      print("REJECTED: no person was asked to act");
      return FAILED;
    }
    logOnce(state.log, "human_step", { status: "done", attempt: state.plan.attempt });
    await openPage(state); // The person changed the page.
    state.history.push({
      step: state.history.length + 1,
      attempt: state.plan.attempt,
      kind: "human",
      operation: "HUMAN",
      action: "A person did the step that needed them",
      text: null,
      url: state.page.url,
      page_changed: true,
    });
  }
  return null;
}

/** What the scans before the agent loop (compare, collect) work with. */
interface RunScan {
  state: session.State;
  browser: Driver;
  policy: Policy;
  recorder: Recorder;
  /** With --more, a scan presses Claude's control for more items when the list ends. */
  more: () => ReturnType<typeof loadMore> | null;
  /** Pressing the control is an action: when its result is uncertain, the run stops as UNCERTAIN. */
  uncertain: (error: MutationUncertain, scan: string) => number;
}

/** With a criterion, compares the whole list once per attempt before anything is acted on. null when the run goes on. */
async function compareStep(ctx: RunScan): Promise<number | null> {
  const { state, browser, policy, recorder } = ctx;
  if (!state.plan.compare || state.plan.compared) return null;
  if (!("compare" in policy)) throw new CliExit("This chooser cannot compare items");
  let scan: Awaited<ReturnType<typeof compareScan>>;
  try {
    scan = await compareScan(browser, policy as unknown as Comparer, state.plan, state.plan.compare, recorder, {
      loadMore: ctx.more(),
    });
  } catch (error) {
    if (error instanceof MutationUncertain) return ctx.uncertain(error, "compare");
    if (!(error instanceof PolicyError || error instanceof StalePage)) throw error;
    // Only scrolls happened. The attempt goes on; run again, or replan.
    recorder.event("compare_failed", {
      attempt: state.plan.attempt,
      error: error.message,
      ...jevDiagnostic(error),
    });
    print(`COMPARE FAILED: ${error.message} Nothing was clicked or typed. Run again, or replan`);
    return FAILED;
  }
  state.plan.compared = scan.compared;
  state.page = scan.page;
  session.save(state);
  print(comparedLine(scan.compared));
  return null;
}

/** With a condition, collects the matching items once per attempt and gives them to Claude; nothing is acted on. */
async function collectStep(ctx: RunScan): Promise<number | null> {
  const { state, browser, policy, recorder } = ctx;
  if (!state.plan.collect || state.plan.collected) return null;
  if (!("collect" in policy)) throw new CliExit("This chooser cannot collect items");
  let scan: Awaited<ReturnType<typeof collectScan>>;
  try {
    scan = await collectScan(browser, policy as unknown as Collector, state.plan, state.plan.collect, recorder, {
      loadMore: ctx.more(),
    });
  } catch (error) {
    if (error instanceof MutationUncertain) return ctx.uncertain(error, "collect");
    if (!(error instanceof PolicyError || error instanceof StalePage)) throw error;
    recorder.event("collect_failed", {
      attempt: state.plan.attempt,
      error: error.message,
      ...jevDiagnostic(error),
    });
    print(`COLLECT FAILED: ${error.message} Nothing was clicked or typed. Run again, or replan`);
    return FAILED;
  }
  state.plan.collected = scan.collected;
  state.page = scan.page;
  session.save(state);
  print(collectedLine(scan.collected));
  print(
    "Nothing was clicked or typed, and the page is back where it was. Check these items against the goal and " +
      "write the answer from them. To put the answer into the page, give it as a value: run --value " +
      "'LABEL=VALUE' (Jev types only values). Otherwise: finish",
  );
  return OK;
}

/** One attempt of the agent loop, and what the log and the state keep of how it ended. */
async function runAttempt(ctx: RunScan): Promise<agent.AgentResult> {
  const { state, browser, policy, recorder } = ctx;
  const result = await runAgent(
    browser,
    policy,
    state.plan,
    recorder,
    new Budget(state.max_actions, state.max_decisions),
    {
      history: state.history,
      page: state.page,
      decisions: state.attempt_decisions,
      // v2 records what its operations did, for the next run on the site (WEBHAND_KNOWLEDGE=0 turns it off).
      knowledge:
        state.plan.flow === "v2" && process.env.WEBHAND_KNOWLEDGE !== "0"
          ? new Knowledge(undefined, process.env.WEBHAND_KNOWLEDGE_USE !== "0")
          : undefined,
      onChange: (page) => {
        state.page = page;
        session.save(state);
      },
      onDecision: (count) => {
        state.attempt_decisions = count;
        state.decisions += 1;
      },
    },
  );
  state.page = result.page;
  state.outcome = result.outcome;
  recorder.event("escalation", {
    reason: result.outcome,
    attempt: state.plan.attempt,
    detail: result.detail,
    ...(result.jev ? { jev: result.jev } : {}),
  });
  if (agent.CHECKED_OUTCOMES.includes(result.outcome)) {
    await agent.checkPage(browser, recorder, "escalation", state.plan.attempt, result.page.url);
  }
  if (result.outcome === agent.NEEDS_HUMAN) {
    recorder.event("human_step", { status: "requested", attempt: state.plan.attempt });
  }
  session.save(state);
  return result;
}

async function commandRun(args: Args): Promise<number> {
  const state = requireSession();
  const rejected = rejectRun(args, state) ?? (await acceptRunInputs(args, state));
  if (rejected !== null) return rejected;
  state.outcome = null;
  session.save(state);

  const policy = deps.policy();
  const browser = await attach(state, null, browserView(state));
  const recorder = new Recorder(state.log);
  const ctx: RunScan = {
    state,
    browser,
    policy,
    recorder,
    more: () => {
      const control = state.plan.more;
      if (!control) return null;
      if (!("more" in policy)) throw new CliExit("This chooser cannot find a control for more items");
      return loadMore(
        browser as Reader,
        policy as unknown as MoreChooser,
        state.plan,
        control,
        recorder,
        state.plan.attempt,
      );
    },
    uncertain: (error, scan) => {
      recorder.event(`${scan}_failed`, { attempt: state.plan.attempt, error: error.message, uncertain: true });
      state.outcome = agent.UNCERTAIN;
      session.save(state);
      print(
        `OUTCOME ${agent.UNCERTAIN}: ${error.message} while loading more items. Do not repeat or replan. Run: webhand finish --status error`,
      );
      return UNCERTAIN;
    },
  };
  let result: agent.AgentResult;
  try {
    const stopped = (await compareStep(ctx)) ?? (await collectStep(ctx));
    if (stopped !== null) return stopped;
    result = await runAttempt(ctx);
  } finally {
    await browser.close();
    recorder.close();
    await policy.close?.();
  }
  return report(state, result);
}

/** v2: Claude answers Jev's question. The same attempt continues: history and budget are kept. */
async function commandAnswer(args: Args): Promise<number> {
  const state = requireSession();
  const plan = state.plan;
  if (plan.flow !== "v2") {
    print("REJECTED: answer is for --flow v2. Use replan");
    return FAILED;
  }
  if (!ANSWERABLE.includes(state.outcome)) {
    print(
      `REJECTED: nothing is waiting for an answer (${state.outcome ?? "the run is not stopped"}). Run: webhand run`,
    );
    return FAILED;
  }
  if (args.url) {
    let url: string;
    try {
      url = runbook.resolveUrl(args.url);
    } catch (error) {
      if (!(error instanceof runbook.RunbookError)) throw error;
      print(`REJECTED: ${error.message.replace("start_url", "--url")}`);
      return FAILED;
    }
    if (!openableUrl(url)) {
      print("REJECTED: --url needs an http, https, or file URL, or a local file path");
      return FAILED;
    }
    await openPage(state, browserUrl(url, state.chrome ?? "linux"), true);
  }
  const values = parseValues(args.value);
  if (values.length) plan.values = mergeValues(plan.values, values);
  plan.instructions = [...(plan.instructions ?? []), args.note];
  // Not an action: it neither counts against the budget nor hides that the page did not change.
  state.history.push({
    step: state.history.length + 1,
    attempt: plan.attempt,
    kind: "answer",
    operation: "ANSWER",
    action: "Claude answered",
    text: null,
    url: state.page.url,
    page_changed: true,
  });
  logOnce(state.log, "answer", {
    attempt: plan.attempt,
    after: state.outcome,
    chars: [...args.note].length,
    values: values.map((v) => v.label),
    ...(args.url ? { url: safeUrl(args.url) } : {}),
  });
  state.outcome = null;
  session.save(state);
  return commandRun({ ...args, value: [], human_done: false });
}

/** Claude revises the plan after an attempt fell short, and starts the next attempt. */
/** A `replan` that cannot be taken: the message after "REJECTED: ". Nothing has been saved yet. */
class ReplanRejected extends Error {}

/** The page --url names, as the browser opens it. null without --url. */
function replanUrl(args: Args, state: session.State): string | null {
  if (!args.url) return null;
  // A path without a scheme is a local file, as the catalog shows a learned page (tasks/fixtures/...).
  let url: string;
  try {
    url = runbook.resolveUrl(args.url);
  } catch (error) {
    if (!(error instanceof runbook.RunbookError)) throw error;
    throw new ReplanRejected(error.message.replace("start_url", "--url"));
  }
  if (!openableUrl(url)) {
    throw new ReplanRejected("--url needs an http, https, or file URL, or a local file path");
  }
  // As start does: the Windows Chrome on WSL opens a local file by its Windows path (round 19).
  return browserUrl(url, state.chrome ?? "linux");
}

/** A value of --compare, --collect or --more: "none" turns it off. */
function switched(value: string): string | null {
  return value === "none" ? null : value;
}

/** Applies the steps, values, compare, collect and more Claude gave to the plan. */
function applyReplanPlan(args: Args, state: session.State): void {
  const plan = state.plan;
  if (args.step.length) {
    const steps = parseSteps(args.step);
    if (steps.some((step) => step.actor === "human") && !state.headed) {
      throw new ReplanRejected("[person] steps need a visible window, and this run is headless");
    }
    plan.steps = steps;
  }
  plan.values = mergeValues(plan.values, parseValues(args.value));
  if (args.compare) plan.compare = switched(args.compare);
  plan.compared = null; // Each attempt compares again from the top.
  if (args.collect) plan.collect = switched(args.collect);
  plan.collected = null; // and collects again.
  if (args.more) plan.more = switched(args.more);
  if (plan.compare && plan.collect) {
    throw new ReplanRejected("use --compare or --collect, not both (turn one off with none)");
  }
  if (plan.more && !plan.compare && !plan.collect) {
    throw new ReplanRejected("--more needs --compare or --collect (turn it off with --more none)");
  }
}

/** Replaces Claude's region choice, on top of what was learned (--read alone keeps the regions). Whether it changed. */
function applyReplanView(args: Args, state: session.State): boolean {
  if (!(args.focus.length || args.skip.length || args.read.length)) return false;
  const regions = args.focus.length || args.skip.length;
  const earlier = state.view_claude ?? { focus: [], skip: [] };
  state.view_claude = {
    focus: regions ? args.focus : earlier.focus,
    skip: regions ? args.skip : earlier.skip,
    read: args.read.length ? args.read : earlier.read,
  };
  state.view = runbook.view(state.view_learned, state.view_claude);
  return true;
}

/** Closes the attempt that ended and opens the next: the outcome, Claude's reason, and the new plan, saved and logged. */
function startNextAttempt(args: Args, state: session.State, url: string | null): void {
  const plan = state.plan;
  const ended = state.outcome || "CLAUDE_STOPPED";
  state.outcomes.push({ attempt: plan.attempt, outcome: ended, reason: args.reason });
  plan.notes.push(`Attempt ${plan.attempt} ended with ${ended}. Claude: ${args.reason}`);
  plan.attempt += 1;
  state.outcome = null;
  state.attempt_decisions = 0;
  session.save(state);
  logOnce(state.log, "attempt_end", { attempt: plan.attempt - 1, outcome: ended, reason: args.reason });
  logOnce(state.log, "plan", {
    attempt: plan.attempt,
    steps: planText(plan),
    values: plan.values.map((v: Value) => v.label),
    view: state.view ?? null,
    ...(plan.compare ? { compare: plan.compare } : {}),
    ...(plan.collect ? { collect: plan.collect } : {}),
    ...(plan.more ? { more: plan.more } : {}),
    restart: args.restart,
    ...(url ? { url: safeUrl(url) } : {}),
    source: "claude",
  });
}

async function commandReplan(args: Args): Promise<number> {
  const state = requireSession();
  const plan = state.plan;
  if (state.outcome === agent.UNCERTAIN) {
    print("REJECTED: the last action may have happened, so the run cannot continue. Run: finish --status error");
    return UNCERTAIN;
  }
  if (plan.attempt >= state.max_attempts) {
    print(`ATTEMPTS EXHAUSTED (${state.max_attempts}). Run: webhand finish --status blocked`);
    return BUDGET;
  }
  let url: string | null;
  let viewChanged: boolean;
  try {
    if (args.url && args.restart) throw new ReplanRejected("use --url or --restart, not both");
    url = replanUrl(args, state);
    applyReplanPlan(args, state);
    viewChanged = applyReplanView(args, state);
  } catch (error) {
    if (!(error instanceof ReplanRejected)) throw error;
    print(`REJECTED: ${error.message}`);
    return FAILED;
  }
  startNextAttempt(args, state, url);
  // Navigation only; no earlier mutation is repeated.
  if (url) await openPage(state, url, true);
  else if (args.restart) await openPage(state, state.start_url, true);
  else if (viewChanged) await openPage(state); // Observe again with the new regions.
  print(
    `${describePlan(plan, state.view ?? null)}\nATTEMPT ${plan.attempt}/${state.max_attempts}\n${headline(state.page)}`,
  );
  print("NEXT: webhand run");
  return OK;
}

async function commandObserve(): Promise<number> {
  const state = requireSession();
  await openPage(state);
  print(render(state.page));
  return OK;
}

/** Claude overrides Jev for one operation. */
async function commandAct(args: Args): Promise<number> {
  const state = requireSession();
  if (state.outcome === agent.NEEDS_HUMAN) {
    print("REJECTED: a person is acting. When they are done: run --human-done");
    return FAILED;
  }
  if (state.outcome === agent.UNCERTAIN) {
    print("REJECTED: the last action may have happened. Run: webhand finish --status error");
    return UNCERTAIN;
  }
  if (agent.actionsIn(state.history, state.plan.attempt).length >= state.max_actions) {
    print("BUDGET EXHAUSTED for this attempt. Run replan or finish --status budget");
    return BUDGET;
  }
  let decision: ReturnType<typeof resolve>;
  try {
    decision = resolve(state.page, args.operation, args.target);
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    print(`REJECTED: ${error.message}`);
    return FAILED;
  }
  if (decision.action === null) {
    print("REJECTED: act runs one operation. Use run, replan, or finish");
    return FAILED;
  }
  if (decision.action.kind === "fill" && args.text === null) {
    print("REJECTED: TYPE_TEXT needs --text");
    return FAILED;
  }
  decision.text = decision.action.kind === "fill" ? args.text : null;
  state.decisions += 1;
  session.save(state);
  const browser = await attach(state, null, browserView(state));
  const recorder = new Recorder(state.log);
  try {
    await execute(browser, state.page, decision, state.history, recorder, {
      decidedBy: "claude",
      attempt: state.plan.attempt,
      values: state.plan.values,
      onChange: (page) => {
        state.page = page;
        session.save(state);
      },
    });
    if (state.outcome !== agent.ATTEMPT_BUDGET) {
      state.outcome = null; // Claude stepped in, so Jev may continue this attempt with run.
      session.save(state);
    }
    print(render(state.page));
    return OK;
  } catch (error) {
    if (error instanceof StalePage) {
      state.page = await browser.observe();
      session.save(state);
      print(`STALE, nothing executed: ${error.message}\n${render(state.page)}`);
      return STALE;
    }
    if (error instanceof MutationUncertain) {
      state.outcome = agent.UNCERTAIN;
      session.save(state);
      print(`UNCERTAIN, do not repeat this action: ${error.message}. Run: webhand finish --status error`);
      return UNCERTAIN;
    }
    throw error;
  } finally {
    await browser.close();
    recorder.close();
  }
}

function runTotals(log: string): Record<string, unknown> {
  const calls: ModelCall[] = [];
  const escalations: Record<string, number> = {};
  const decidedBy: Record<string, number> = {};
  let handoffs = 0;
  let handoffChars = 0;
  let notVisible = 0;
  let stale = 0;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { type, ...event } = JSON.parse(line);
    if (type === "call") calls.push(event as ModelCall);
    else if (type === "escalation") escalations[event.reason] = (escalations[event.reason] ?? 0) + 1;
    else if (type === "step") decidedBy[event.decided_by] = (decidedBy[event.decided_by] ?? 0) + 1;
    else if (type === "not_visible") notVisible += 1;
    else if (type === "stale") stale += 1;
    else if (type === "handoff") {
      handoffs += 1;
      handoffChars += event.chars;
    }
  }
  return {
    ...summarize(calls),
    escalations,
    decided_by: decidedBy,
    handoffs,
    handoff_chars: handoffChars,
    not_visible: notVisible,
    stale,
  };
}

/** Verifies the page independently when a verifier was given. The status is what the agent claims, nothing more. */
async function commandFinish(args: Args): Promise<number> {
  const state = session.load();
  if (state === null) throw new CliExit("No active session. Run: webhand start");
  let verdict: Verdict = { success: null, evidence: "no verifier" };
  try {
    const verify = context.hooks.verify;
    if (verify) {
      const browser = await attach(state, null);
      try {
        verdict = await verify(browser as Browser, state); // A remote browser has evaluate, which is what verifiers use.
      } finally {
        await browser.close();
      }
    }
  } catch (error) {
    verdict = { success: false, evidence: describeError(error) };
  } finally {
    await session.stopChrome(state);
    session.clear();
  }
  const plan = state.plan;
  // v2: a run that finished as done marks its steps as the way that worked.
  if (args.status === "done" && plan.flow === "v2" && process.env.WEBHAND_KNOWLEDGE !== "0") {
    new Knowledge().confirm(state.history);
  }
  const outcomes = [...state.outcomes, { attempt: plan.attempt, outcome: state.outcome, reason: args.reason }];
  const totals = runTotals(state.log);
  logOnce(state.log, "run_end", {
    status: args.status,
    reason: args.reason,
    service: state.service ?? null,
    runbook: state.runbook ?? null,
    goal: plan.goal,
    plan: planText(plan),
    attempts: plan.attempt,
    attempt_outcomes: outcomes,
    actions: agent.executed(state.history).length,
    decisions: state.decisions,
    elapsed_ms: Math.round((Date.now() / 1000 - state.started) * 1000),
    verified: verdict.success,
    evidence: verdict.evidence,
    ...totals,
  });
  print(`FINISHED status=${args.status} verified=${show(verdict.success)} attempts=${plan.attempt} log=${state.log}`);
  return OK;
}

function parentAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Stops a long-running command on SIGTERM or SIGINT, or when the process that started it is gone,
 * and still saves and closes. npx does not pass SIGTERM on, so stopping an `npx webhand learn` job
 * ends npx alone; its end is the signal here.
 */
function stopSignals(): { stopped: () => boolean; release: () => void } {
  let stopped = false;
  const parent = process.ppid;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return {
    stopped: () => stopped || !parentAlive(parent),
    release: () => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    },
  };
}

/** A person demonstrates a procedure. A long-running command, so run it in the background. */
async function commandLearn(args: Args): Promise<number> {
  let profile: string | null;
  let chrome: string;
  let note: string | null;
  let runbookFile: string;
  let serviceFile: string | null;
  try {
    runbookFile = runbook.path(args.name, args.scope);
    const parts = String(args.name).split("/");
    serviceFile = parts.length > 1 ? runbook.servicePath(parts[0], args.scope) : null;
    profile = session.parseSession(args.session);
    [chrome, note] = chooseChrome(args.chrome);
  } catch (error) {
    if (error instanceof runbook.RunbookError || error instanceof session.SessionError) {
      throw new CliExit(error.message);
    }
    throw error;
  }
  const stem = String(args.name).replaceAll("/", "-");
  context.log = defaultLog(`learn-${stem}`);
  const log = context.log;
  let chromeState: session.State;
  try {
    chromeState = await session.startChrome({ headed: !args.headless, profile, chrome });
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
  const deadline = performance.now() + args.max_minutes * 60_000;
  let browser: Browser | null = null;
  const recorder = new Recorder(log);
  const signals = stopSignals(); // Stopping the job still saves and closes.
  let counts: Record<string, number>;
  try {
    browser = await Browser.open(null, { port: chromeState.port });
    recorder.event("learn_start", {
      name: args.name,
      url: args.url,
      scope: args.scope,
      chrome: browser.version,
      chrome_host: chrome,
      session: profile ? "profile" : "new",
      git: gitState(),
      started_at: new Date().toISOString(),
    });
    counts = await learn.record(
      browser,
      browserUrl(args.url, chrome),
      recorder,
      () => signals.stopped() || performance.now() >= deadline,
    );
    recorder.event("learn_end", { counts });
  } finally {
    signals.release();
    await browser?.close();
    await session.stopChrome(chromeState);
    recorder.close();
  }
  if (note) print(`NOTE: ${note}`);
  print(`RECORDED ${quote(counts)} log=${log}`);
  print(`WRITE THE RUNBOOK TO ${runbookFile}`);
  if (serviceFile) print(`WRITE THE SERVICE INFORMATION TO ${serviceFile}`);
  if (counts.unsupported) {
    print("WARNING: the record has operations the agent cannot reproduce. See its unsupported events");
  }
  return OK;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Saved webhand profiles. A person signs in here directly; nothing is recorded or sent to Jev. */
async function commandProfile(args: Args): Promise<number> {
  let chromeState: session.State;
  let chrome: string;
  try {
    let note: string | null;
    [chrome, note] = chooseChrome(args.chrome);
    if (note) print(`NOTE: ${note}`);
    if (args.action === "list") {
      const profiles = listProfiles(chrome);
      print(`SAVED PROFILES (${chrome}): ${profiles.length ? profiles.join(", ") : "(none)"}`);
      return OK;
    }
    if (!args.name) throw new CliExit(`profile ${args.action} needs a NAME`);
    const folder = profileDir(chrome, args.name);
    if (args.action === "delete") {
      if (!isDir(folder)) {
        print(`No saved profile ${args.name}`);
        return FAILED;
      }
      session.deleteProfile(folder);
      print(`DELETED profile ${args.name}`);
      return OK;
    }
    if (!args.url) throw new CliExit("profile login needs --url");
    if (session.active().some(([, state]) => state.saved_profile === args.name)) {
      throw new CliExit(`Profile ${args.name} is in use by an active run. Finish it first`);
    }
    chromeState = await session.startChrome({ headed: true, profile: args.name, chrome });
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
  const deadline = performance.now() + args.max_minutes * 60_000;
  const signals = stopSignals();
  try {
    await (await Browser.open(browserUrl(args.url, chrome), { port: chromeState.port })).close();
    // stdout is buffered for the handoff count, so the person sees this on stderr right away.
    context.err(`OPENED profile ${args.name}. Sign in in the Chrome window, then close the window\n`);
    await session.waitUntilClosed(chromeState, () => signals.stopped() || performance.now() >= deadline);
  } finally {
    signals.release();
    await session.stopChrome(chromeState);
  }
  print(`SAVED profile ${args.name}. Use it with: start --session profile:${args.name}`);
  return OK;
}

/** What webhand learned about sites from its own runs: list, show HOST, clear [HOST]. */
async function commandKnowledge(args: Args): Promise<number> {
  const knowledge = new Knowledge();
  if (args.action === "list") {
    const hosts = knowledge.hosts();
    if (!hosts.length) print("KNOWN SITES: (none)");
    for (const h of hosts) print(`${h.host}: ${h.pages} pages, ${h.operations} operations, ${h.worked} that worked`);
    return OK;
  }
  if (args.action === "show") {
    if (!args.name) throw new CliExit("knowledge show needs a HOST");
    const lines = knowledge.describe(args.name);
    print(lines.length ? lines.join("\n") : `Nothing is known about ${args.name}`);
    return lines.length ? OK : FAILED;
  }
  const removed = knowledge.forget(args.name ?? null);
  print(`FORGOT ${removed} ${removed === 1 ? "site" : "sites"}${args.name ? ` (${args.name})` : ""}`);
  return OK;
}

async function commandAuth(args: Args): Promise<number> {
  try {
    if (args.action === "list") {
      const names = auth.names();
      print(`SAVED LOGINS: ${names.length ? names.join(", ") : "(none)"}`);
      return OK;
    }
    if (!args.name) throw new CliExit(`auth ${args.action} needs a NAME`);
    auth.checkName(args.name);
    if (args.action === "delete") {
      if (!auth.remove(args.name)) {
        print(`No saved login ${args.name}`);
        return FAILED;
      }
      print(`DELETED login ${args.name}`);
      return OK;
    }
    const state = requireSession();
    const replaced = auth.exists(args.name);
    const browser = await attach(state, null, browserView(state));
    let storage: auth.StorageState;
    try {
      storage = await browser.storageState();
    } finally {
      await browser.close();
    }
    auth.save(args.name, storage);
    print(
      `${replaced ? "REPLACED" : "SAVED"} login ${args.name} (${auth.summary(auth.load(args.name))}). Use it with: start --auth ${args.name}`,
    );
    return OK;
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
}

const FLOWS = ["v1", "v2"];

function commands(): Record<string, CommandSpec> {
  const chromeDefault = process.env.WEBHAND_CHROME ?? "auto";
  const idOption: OptionSpec = {
    name: "id",
    type: "string",
    default: session.DEFAULT_ID,
    help: "Name of the session, to run several at once. Give the same --id to every command of one session",
  };
  const chromeOption: OptionSpec = {
    name: "chrome",
    type: "string",
    choices: [...CHROMES].sort(),
    default: chromeDefault,
    help: "auto uses the Windows Chrome on WSL when it is reachable",
  };
  const engineOption: OptionSpec = {
    name: "engine",
    type: "string",
    choices: [...ENGINE_CHOICES],
    default: process.env.WEBHAND_ENGINE ?? "auto",
    help: "What runs the browser. auto (default) uses the headless shell when it is installed and the run needs no window or saved profile, else Chrome. headless-shell, lightpanda, obscura, browser-run and kitesurf have no window and no saved profile, and --chrome does not apply to them. browser-run runs on Cloudflare (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN; kitesurf is its stateless agent browser), so the pages it opens are sent there. Default: WEBHAND_ENGINE, else auto",
  };
  const viewOptions: OptionSpec[] = [
    {
      name: "focus",
      type: "string",
      multiple: true,
      metavar: "REGION",
      help: "A region to show first, such as form:予約",
    },
    { name: "skip", type: "string", multiple: true, metavar: "REGION", help: "A region to leave out" },
    {
      name: "read",
      type: "string",
      multiple: true,
      metavar: "KIND",
      choices: [...runbook.READ_KINDS, "none"],
      help: "Content to read beyond the viewport: outline, text, table, list, link, control, media; none clears it",
    },
  ];
  const compareOption: OptionSpec = {
    name: "compare",
    type: "string",
    metavar: "CRITERION",
    help: "Before acting, scroll through the whole list and find the item that best meets this; none clears it",
  };
  const collectOption: OptionSpec = {
    name: "collect",
    type: "string",
    metavar: "CONDITION",
    help: "First scroll through the whole list and collect every item that meets this, then stop; none clears it",
  };
  const moreOption: OptionSpec = {
    name: "more",
    type: "string",
    metavar: "CONTROL",
    help: "With --compare or --collect, press this control when the list ends, such as Next page; none clears it",
  };
  return {
    catalog: {
      help: "List learned services, procedures, and saved profiles",
      options: [chromeOption],
      run: commandCatalog,
    },
    start: {
      help: "Record Claude's plan and open the start page",
      options: [
        idOption,
        { name: "goal", type: "string" },
        { name: "url", type: "string" },
        { name: "step", type: "string", multiple: true, help: 'A plan step. "[person] ..." is done by a person' },
        { name: "value", type: "string", multiple: true, metavar: "LABEL=VALUE", help: "Text Jev may type" },
        { name: "service", type: "string", help: "Learned service information to give Jev, such as hotel-site" },
        { name: "runbook", type: "string", help: "A learned procedure, such as hotel/filter" },
        { name: "param", type: "string", multiple: true, metavar: "KEY=VALUE", help: "A runbook parameter" },
        { name: "allow-draft", type: "boolean", help: "Trial a runbook no person has approved yet" },
        ...viewOptions,
        compareOption,
        collectOption,
        moreOption,
        {
          name: "flow",
          type: "string",
          choices: [...FLOWS],
          default: process.env.WEBHAND_FLOW || "v2",
          help: "v2 (default): offer Jev the whole page; v1: only what is in view. Default: WEBHAND_FLOW, else v2",
        },
        { name: "session", type: "string", default: "new", help: "new (temporary) or profile:NAME (saved sign-in)" },
        {
          name: "auth",
          type: "string",
          metavar: "NAME",
          help: "Start signed in with a login saved by `auth save`. For a new session only: not with --id or profile:NAME",
        },
        chromeOption,
        engineOption,
        { name: "headed", type: "boolean" },
        { name: "max-attempts", type: "int", default: DEFAULT_ATTEMPTS },
        { name: "max-actions", type: "int", default: Budget.MAX_ACTIONS, help: "Per attempt" },
        { name: "max-decisions", type: "int", default: Budget.MAX_DECISIONS, help: "Per attempt" },
      ],
      conflicts: [["auth", "id"]],
      run: commandStart,
    },
    run: {
      help: "Jev: work toward the goal until Claude or a person is needed",
      options: [
        idOption,
        { name: "value", type: "string", multiple: true, metavar: "LABEL=VALUE", help: "Add or replace a value" },
        { name: "human-done", type: "boolean", help: "The person finished what NEEDS_HUMAN asked" },
      ],
      run: commandRun,
    },
    answer: {
      help: "Claude (v2): answer Jev's question and continue the same attempt",
      options: [
        idOption,
        { name: "note", type: "string", required: true, help: "A short instruction for Jev; it sees it" },
        { name: "value", type: "string", multiple: true, metavar: "LABEL=VALUE", help: "Add or replace a value" },
        { name: "url", type: "string", help: "Open this page first (the same attempt continues)" },
      ],
      run: commandAnswer,
    },
    replan: {
      help: "Claude: revise the plan and start the next attempt",
      options: [
        idOption,
        { name: "reason", type: "string", required: true, help: "Why the last attempt fell short; Jev sees it" },
        { name: "step", type: "string", multiple: true, help: "Replace the steps" },
        { name: "value", type: "string", multiple: true, metavar: "LABEL=VALUE" },
        { name: "restart", type: "boolean", help: "Open the start URL again before the next attempt" },
        { name: "url", type: "string", help: "Open this URL before the next attempt instead (another way in)" },
        ...viewOptions,
        compareOption,
        collectOption,
        moreOption,
      ],
      run: commandReplan,
    },
    act: {
      help: "Claude: override Jev with one operation",
      options: [idOption, { name: "text", type: "string" }],
      positionals: [{ name: "operation" }, { name: "target", optional: true }],
      run: commandAct,
    },
    observe: { help: "Print the current page", options: [idOption], run: commandObserve },
    finish: {
      help: "Verify, log, and close Chrome",
      options: [
        idOption,
        {
          name: "status",
          type: "string",
          required: true,
          choices: ["done", "blocked", "budget", "error", "abandoned"],
        },
        { name: "reason", type: "string" },
      ],
      run: commandFinish,
    },
    learn: {
      help: "Record a person demonstrating a procedure",
      options: [
        { name: "name", type: "string", required: true, help: "Runbook name, such as hotel/filter" },
        { name: "url", type: "string", required: true },
        {
          name: "scope",
          type: "string",
          choices: ["project", "user"],
          default: "project",
          help: "Where the runbook belongs: this project's .webhand or your ~/.webhand",
        },
        { name: "session", type: "string", default: "new", help: "new or profile:NAME, to demonstrate signed in" },
        chromeOption,
        { name: "max-minutes", type: "float", default: 30 },
        { name: "headless", type: "boolean", hidden: true },
      ],
      run: commandLearn,
    },
    auth: {
      help: "Saved logins: list, save NAME (from a session), delete NAME",
      options: [idOption],
      positionals: [
        { name: "action", choices: ["list", "save", "delete"] },
        { name: "name", optional: true },
      ],
      run: commandAuth,
    },
    knowledge: {
      help: "What webhand learned about sites from its own runs: list, show HOST, clear [HOST]",
      options: [],
      positionals: [
        { name: "action", choices: ["list", "show", "clear"] },
        { name: "name", optional: true },
      ],
      run: commandKnowledge,
    },
    profile: {
      help: "Saved profiles: list, login NAME --url URL, delete NAME",
      options: [{ name: "url", type: "string" }, chromeOption, { name: "max-minutes", type: "float", default: 15 }],
      positionals: [
        { name: "action", choices: ["list", "login", "delete"] },
        { name: "name", optional: true },
      ],
      run: commandProfile,
    },
  };
}

export interface IO {
  out: (text: string) => void;
  err: (text: string) => void;
}

const processIO: IO = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

/**
 * Runs one command and returns its exit code. A CliExit or UsageError is thrown after the output is written,
 * so the caller prints its message and exits with 1 or 2.
 */
const SESSION_COMMANDS = ["start", "run", "answer", "replan", "act", "observe", "finish"];

/** Picks the session a command works on and holds its lock until the command ends. Returns the release function. */
function takeSession(command: string, args: Args): () => void {
  if (!SESSION_COMMANDS.includes(command) && !(command === "auth" && args.action === "save")) {
    session.use();
    return () => {};
  }
  try {
    session.use(args.id);
    return session.lock();
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
}

/** Parses argv against the commands below. */
export function parse(argv: string[]): Parsed | { help: string } {
  return parseArgs(argv, commands());
}

export async function main(argv: string[], io: IO = processIO, hooks: Hooks = {}): Promise<number> {
  const parsed = parse(argv);
  if ("help" in parsed) {
    io.out(parsed.help);
    return OK;
  }
  context = { out: [], err: io.err, log: null, hooks };
  const current = context;
  const release = takeSession(parsed.command, parsed.args);
  // What Claude must read is a real cost of this design, so every handoff is sized and logged.
  try {
    return await parsed.run(parsed.args);
  } finally {
    release();
    const text = current.out.join("");
    io.out(text);
    if (current.log) logOnce(current.log, "handoff", { command: parsed.command, chars: [...text].length });
  }
}
