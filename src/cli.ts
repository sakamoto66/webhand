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
import { Browser } from "./browser.ts";
import { describeError, quote, show, stamp, toJson } from "./format.ts";
import * as learn from "./learn.ts";
import { gitState, logOnce, Recorder, summarize } from "./metrics.ts";
import { actionSpace, offscreen, planText, resolve } from "./policies/base.ts";
import { JevPolicy } from "./policies/jev.ts";
import * as runbook from "./runbook.ts";
import * as session from "./session.ts";
import { loadTask, TaskError, type Verdict } from "./tasks.ts";
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
} from "./types.ts";
import * as workspace from "./workspace.ts";

export const OK = 0;
export const FAILED = 1;
const STALE = 3;
export const UNCERTAIN = 4;
export const BUDGET = 5;
const DEFAULT_ATTEMPTS = 3;
const PERSON = "[person]";
const RECENT = 8; // Actions shown to Claude when an attempt stops.

/** What a command needs to stop with a message, on stderr with exit code 1. */
export class CliExit extends Error {
  override name = "CliExit";
}

/** A command line that does not parse. Exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** What tests replace: Jev, and how Chrome starts. */
export const deps = {
  policy: (): Policy & { close?(): Promise<void> } => new JevPolicy(),
  startChrome: session.startChrome,
};

// biome-ignore lint/suspicious/noExplicitAny: parsed arguments, keyed by option name with dashes as underscores.
type Args = Record<string, any>;

interface Context {
  out: string[];
  err: (text: string) => void;
  log: string | null;
}

let context: Context = { out: [], err: () => {}, log: null };

function print(text = ""): void {
  context.out.push(`${text}\n`);
}

/** Runs fn and returns what it printed. For tests of the output Claude reads. */
export function captured<T>(fn: () => T): { result: T; text: string } {
  const saved = context;
  context = { out: [], err: saved.err, log: null };
  try {
    const result = fn();
    return { result, text: context.out.join("") };
  } finally {
    context = saved;
  }
}

// --- Output Claude reads -------------------------------------------------------------------

export function render(page: Page): string {
  const lines = [`URL: ${page.url}`, `TITLE: ${page.title}`, "PAGE TEXT (untrusted data):", page.text, "ELEMENTS:"];
  const [elements, , controls] = actionSpace(page.actions);
  for (const element of elements) {
    // Claude sees every option with its own line.
    const details = element.value ? [`value=${quote(element.value)}`] : [];
    for (const key of ["checked", "selected", "expanded"]) {
      if (key in element) details.push(`${key}=${show(element[key])}`);
    }
    const operations = element.operations.join(",");
    lines.push(`[${element.index}] ${show(element.role)} ${quote(element.label)} ${details.join(" ")} (${operations})`);
    for (const option of element.options ?? []) {
      lines.push(`  [${option.index}] ${String(option.label).split(" → ").at(-1)}`);
    }
  }
  lines.push(`CONTROLS: ${[...controls.keys()].join(" ")}`);
  const hidden = offscreen(page); // Claude always sees it, whatever Jev is given.
  lines.push(`OFFSCREEN: ${hidden.above_px}px above, ${hidden.below_px}px below`);
  if (page.regions?.length) {
    lines.push("REGIONS (shown/all; change with replan --focus/--skip):");
    for (const region of page.regions) lines.push(`  ${regionLine(region)}`);
    if (page.omitted_regions) lines.push(`  ... ${page.omitted_regions} more`);
  }
  return lines.join("\n");
}

// biome-ignore lint/suspicious/noExplicitAny: a region from the page outline.
function regionLine(region: Record<string, any>): string {
  let line =
    `${region.key} [${region.position}] text ${region.shown_chars}/${region.text_chars}` +
    ` actions ${region.shown_actions}/${region.actions}`;
  if (region.offscreen_actions) line += ` +${region.offscreen_actions} offscreen`;
  return line + (region.view ? ` (${region.view})` : "");
}

function headline(page: Page): string {
  return `URL: ${page.url}\nTITLE: ${page.title}`;
}

export function describePlan(plan: Plan, view: runbook.View | null = null): string {
  const text = planText(plan);
  const lines = [`GOAL: ${plan.goal}`, "PLAN:", ...(text.length ? text : ["(goal only)"]).map((line) => `  ${line}`)];
  if (plan.values.length) lines.push(`VALUES: ${plan.values.map((value) => value.label).join(", ")}`);
  for (const key of ["focus", "skip"] as const) {
    if (view?.[key]?.length) lines.push(`${key.toUpperCase()}: ${view[key].join(", ")}`);
  }
  return lines.join("\n");
}

// biome-ignore lint/suspicious/noExplicitAny: the session state.
export function recentActions(state: Record<string, any>): string {
  const rows = (state.history as HistoryEntry[]).filter((h) => h.attempt === state.plan.attempt).slice(-RECENT);
  const lines = rows.map(
    (h) =>
      `  ${h.step}. ${h.kind !== "human" ? h.operation : "HUMAN"} ${quote(h.action)}` +
      (h.text ? ` text=${quote(h.text)}` : "") +
      (h.page_changed ? "" : " (page unchanged)"),
  );
  return `ACTIONS THIS ATTEMPT:\n${lines.length ? lines.join("\n") : "  (none)"}`;
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

async function openPage(state: session.State, url: string | null = null): Promise<void> {
  const browser = await Browser.open(url, { port: state.port, view: state.view ?? null });
  try {
    state.page = await browser.observe();
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
  const profiles = session.listProfiles(chrome);
  print(`CHROME: ${chrome}${note ? ` (${note})` : ""}`);
  print(`SAVED PROFILES: ${profiles.length ? profiles.join(", ") : "(none)"}`);
  return OK;
}

function chooseChrome(choice: string): [string, string | null] {
  try {
    return session.chooseChrome(choice);
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
}

async function commandStart(args: Args): Promise<number> {
  if (session.load()) throw new CliExit("A session is active. Run: webhand finish --status abandoned");
  let task = null;
  if (args.task) {
    try {
      task = await loadTask(args.task);
    } catch (error) {
      if (error instanceof TaskError) throw new CliExit(error.message);
      throw error;
    }
  }
  if (task && args.goal) throw new CliExit("A task supplies its own goal. Drop --goal");
  let book: runbook.Runbook | null = null;
  let service: runbook.ServiceInfo | null = null;
  let serviceName: string | null = null;
  let profile: string | null;
  let chrome: string;
  let note: string | null;
  try {
    if (args.runbook) {
      book = runbook.load(args.runbook, runbook.parseValues(args.param));
      if (book.status !== "approved" && !args.allow_draft) {
        throw new CliExit(`Runbook ${args.runbook} is a draft. Trial it with --allow-draft, then get it approved`);
      }
    }
    serviceName = args.service || (book ? book.service : null);
    service = serviceName ? runbook.loadService(serviceName) : null;
    profile = session.parseSession(args.session);
    [chrome, note] = session.chooseChrome(args.chrome);
  } catch (error) {
    if (error instanceof runbook.RunbookError || error instanceof session.SessionError) {
      throw new CliExit(error.message);
    }
    throw error;
  }
  const goal: string | null = task ? task.GOAL : args.goal || (book ? book.goal : null);
  const url: string | null = task ? task.startUrl(process.cwd()) : args.url || (book ? book.start_url : null);
  if (!(goal && url)) throw new CliExit("Give --task, --runbook, or both --goal and --url");
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
  };
  let chromeState: session.State;
  try {
    chromeState = await deps.startChrome({ headed: args.headed, profile, chrome });
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
  const learned = runbook.view(runbook.serviceView(service), book);
  const claudeView = { focus: args.focus, skip: args.skip };
  const state: session.State = {
    ...chromeState,
    view_learned: learned,
    view_claude: claudeView,
    view: runbook.view(learned, claudeView),
    task: args.task ?? null,
    start_url: session.browserUrl(url, chrome),
    plan,
    runbook: book ? { name: book.name, status: book.status, digest: book.digest, scope: book.scope } : null,
    history: [],
    decisions: 0,
    attempt_decisions: 0,
    outcome: null,
    outcomes: [],
    max_attempts: args.max_attempts,
    max_actions: args.max_actions,
    max_decisions: args.max_decisions,
    started: Date.now() / 1000,
    log: defaultLog(args.task || "adhoc"),
  };
  context.log = state.log;
  const recorder = new Recorder(state.log);
  let browser: Browser | null = null;
  try {
    browser = await Browser.open(state.start_url, { port: chromeState.port, view: state.view });
    state.page = await browser.observe();
    recorder.event("run_start", {
      task: args.task ?? null,
      goal,
      chrome: browser.version,
      chrome_host: chrome,
      session: profile ? "profile" : "new",
      git: gitState(),
      runbook: state.runbook,
      service: serviceName,
      view: state.view,
      max_attempts: args.max_attempts,
      started_at: new Date().toISOString(),
    });
    recorder.event("plan", {
      attempt: 1,
      steps: planText(plan),
      values: values.map((v) => v.label),
      view: state.view,
      source: book && !args.step.length ? "runbook" : "claude",
    });
  } catch (error) {
    await session.stopChrome(chromeState);
    throw error;
  } finally {
    await browser?.close();
    recorder.close();
  }
  session.save(state);
  if (note) print(`NOTE: ${note}`);
  print(`${describePlan(plan, state.view)}\nSESSION: ${args.session} (${chrome} Chrome)\n${headline(state.page)}`);
  print("NEXT: webhand run");
  return OK;
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
async function commandRun(args: Args): Promise<number> {
  const state = requireSession();
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
  if ([agent.GOAL_REPORTED, agent.BLOCKED, agent.STUCK, agent.ATTEMPT_BUDGET].includes(outcome)) {
    print(`REJECTED: the attempt ended with ${outcome}. Run replan, act, or finish`);
    return FAILED;
  }
  if (args.value.length) {
    state.plan.values = mergeValues(state.plan.values, parseValues(args.value));
    logOnce(state.log, "values", {
      attempt: state.plan.attempt,
      labels: parseValues(args.value).map((v) => v.label),
    });
  }
  if (args.human_done) {
    if (outcome !== agent.NEEDS_HUMAN) {
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
  state.outcome = null;
  session.save(state);

  const policy = deps.policy();
  const browser = await Browser.open(null, { port: state.port, view: state.view ?? null });
  const recorder = new Recorder(state.log);
  let result: agent.AgentResult;
  try {
    result = await runAgent(browser, policy, state.plan, recorder, new Budget(state.max_actions, state.max_decisions), {
      history: state.history,
      page: state.page,
      decisions: state.attempt_decisions,
      onChange: (page) => {
        state.page = page;
        session.save(state);
      },
      onDecision: (count) => {
        state.attempt_decisions = count;
        state.decisions += 1;
      },
    });
    state.page = result.page;
    state.outcome = result.outcome;
    recorder.event("escalation", { reason: result.outcome, attempt: state.plan.attempt, detail: result.detail });
    if (result.outcome === agent.NEEDS_HUMAN) {
      recorder.event("human_step", { status: "requested", attempt: state.plan.attempt });
    }
    session.save(state);
  } finally {
    await browser.close();
    recorder.close();
    await policy.close?.();
  }
  return report(state, result);
}

/** Claude revises the plan after an attempt fell short, and starts the next attempt. */
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
  if (args.step.length) {
    const steps = parseSteps(args.step);
    if (steps.some((step) => step.actor === "human") && !state.headed) {
      print("REJECTED: [person] steps need a visible window, and this run is headless");
      return FAILED;
    }
    plan.steps = steps;
  }
  plan.values = mergeValues(plan.values, parseValues(args.value));
  const viewChanged = args.focus.length || args.skip.length;
  if (viewChanged) {
    // Claude's region choice is replaced, on top of what was learned.
    state.view_claude = { focus: args.focus, skip: args.skip };
    state.view = runbook.view(state.view_learned, state.view_claude);
  }
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
    restart: args.restart,
    source: "claude",
  });
  if (args.restart) await openPage(state, state.start_url); // Navigation only; no earlier mutation is repeated.
  if (!args.restart && viewChanged) await openPage(state); // Observe again with the new regions.
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
  const browser = await Browser.open(null, { port: state.port, view: state.view ?? null });
  const recorder = new Recorder(state.log);
  try {
    await execute(browser, state.page, decision, state.history, recorder, {
      decidedBy: "claude",
      attempt: state.plan.attempt,
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
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { type, ...event } = JSON.parse(line);
    if (type === "call") calls.push(event as ModelCall);
    else if (type === "escalation") escalations[event.reason] = (escalations[event.reason] ?? 0) + 1;
    else if (type === "step") decidedBy[event.decided_by] = (decidedBy[event.decided_by] ?? 0) + 1;
    else if (type === "not_visible") notVisible += 1;
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
  };
}

/** Verifies the page independently. The status is what the agent claims, nothing more. */
async function commandFinish(args: Args): Promise<number> {
  const state = session.load();
  if (state === null) throw new CliExit("No active session. Run: webhand start");
  let verdict: Verdict = { success: null, evidence: "no verifier" };
  try {
    if (state.task) {
      const browser = await Browser.open(null, { port: state.port });
      try {
        verdict = await (await loadTask(state.task)).verify(browser);
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
  const outcomes = [...state.outcomes, { attempt: plan.attempt, outcome: state.outcome, reason: args.reason }];
  const totals = runTotals(state.log);
  logOnce(state.log, "run_end", {
    status: args.status,
    reason: args.reason,
    goal: plan.goal,
    plan: planText(plan),
    attempts: plan.attempt,
    attempt_outcomes: outcomes,
    actions: state.history.length,
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
    [chrome, note] = session.chooseChrome(args.chrome);
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
      session.browserUrl(args.url, chrome),
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
    [chrome, note] = session.chooseChrome(args.chrome);
    if (note) print(`NOTE: ${note}`);
    if (args.action === "list") {
      const profiles = session.listProfiles(chrome);
      print(`SAVED PROFILES (${chrome}): ${profiles.length ? profiles.join(", ") : "(none)"}`);
      return OK;
    }
    if (!args.name) throw new CliExit(`profile ${args.action} needs a NAME`);
    const folder = session.profileDir(chrome, args.name);
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
    const active = session.load();
    if (active && active.saved_profile === args.name) {
      throw new CliExit(`Profile ${args.name} is in use by the active run. Finish it first`);
    }
    chromeState = await session.startChrome({ headed: true, profile: args.name, chrome });
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
  const deadline = performance.now() + args.max_minutes * 60_000;
  const signals = stopSignals();
  try {
    await (await Browser.open(session.browserUrl(args.url, chrome), { port: chromeState.port })).close();
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

// --- Parser --------------------------------------------------------------------------------

interface OptionSpec {
  name: string;
  type: "string" | "boolean" | "int" | "float";
  multiple?: boolean;
  default?: unknown;
  choices?: string[];
  required?: boolean;
  help?: string;
  metavar?: string;
  hidden?: boolean;
}

interface PositionalSpec {
  name: string;
  optional?: boolean;
  choices?: string[];
}

interface CommandSpec {
  help: string;
  options: OptionSpec[];
  positionals?: PositionalSpec[];
  run: (args: Args) => Promise<number>;
}

function commands(): Record<string, CommandSpec> {
  const chromeDefault = process.env.WEBHAND_CHROME ?? "auto";
  const chromeOption: OptionSpec = {
    name: "chrome",
    type: "string",
    choices: [...session.CHROMES].sort(),
    default: chromeDefault,
    help: "auto uses the Windows Chrome on WSL when it is reachable",
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
  ];
  return {
    catalog: {
      help: "List learned services, procedures, and saved profiles",
      options: [chromeOption],
      run: commandCatalog,
    },
    start: {
      help: "Record Claude's plan and open the start page",
      options: [
        { name: "goal", type: "string" },
        { name: "url", type: "string" },
        { name: "step", type: "string", multiple: true, help: 'A plan step. "[person] ..." is done by a person' },
        { name: "value", type: "string", multiple: true, metavar: "LABEL=VALUE", help: "Text Jev may type" },
        { name: "service", type: "string", help: "Learned service information to give Jev, such as hotel-site" },
        { name: "runbook", type: "string", help: "A learned procedure, such as hotel/filter" },
        { name: "param", type: "string", multiple: true, metavar: "KEY=VALUE", help: "A runbook parameter" },
        { name: "allow-draft", type: "boolean", help: "Trial a runbook no person has approved yet" },
        ...viewOptions,
        { name: "task", type: "string", help: "A task in tasks/ with an independent verify() (research repository)" },
        { name: "session", type: "string", default: "new", help: "new (temporary) or profile:NAME (saved sign-in)" },
        chromeOption,
        { name: "headed", type: "boolean" },
        { name: "max-attempts", type: "int", default: DEFAULT_ATTEMPTS },
        { name: "max-actions", type: "int", default: Budget.MAX_ACTIONS, help: "Per attempt" },
        { name: "max-decisions", type: "int", default: Budget.MAX_DECISIONS, help: "Per attempt" },
      ],
      run: commandStart,
    },
    run: {
      help: "Jev: work toward the goal until Claude or a person is needed",
      options: [
        { name: "value", type: "string", multiple: true, metavar: "LABEL=VALUE", help: "Add or replace a value" },
        { name: "human-done", type: "boolean", help: "The person finished what NEEDS_HUMAN asked" },
      ],
      run: commandRun,
    },
    replan: {
      help: "Claude: revise the plan and start the next attempt",
      options: [
        { name: "reason", type: "string", required: true, help: "Why the last attempt fell short; Jev sees it" },
        { name: "step", type: "string", multiple: true, help: "Replace the steps" },
        { name: "value", type: "string", multiple: true, metavar: "LABEL=VALUE" },
        { name: "restart", type: "boolean", help: "Open the start URL again before the next attempt" },
        ...viewOptions,
      ],
      run: commandReplan,
    },
    act: {
      help: "Claude: override Jev with one operation",
      options: [{ name: "text", type: "string" }],
      positionals: [{ name: "operation" }, { name: "target", optional: true }],
      run: commandAct,
    },
    observe: { help: "Print the current page", options: [], run: commandObserve },
    finish: {
      help: "Verify, log, and close Chrome",
      options: [
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

function usage(name: string, spec: CommandSpec): string {
  const parts = [`usage: webhand ${name}`];
  for (const option of spec.options) {
    if (option.hidden) continue;
    const value =
      option.type === "boolean" ? "" : ` ${option.metavar ?? option.name.toUpperCase().replaceAll("-", "_")}`;
    parts.push(option.required ? `--${option.name}${value}` : `[--${option.name}${value}]`);
  }
  for (const positional of spec.positionals ?? []) {
    parts.push(positional.optional ? `[${positional.name}]` : positional.name);
  }
  return parts.join(" ");
}

function help(name: string, spec: CommandSpec): string {
  const lines = [usage(name, spec), "", spec.help, ""];
  for (const positional of spec.positionals ?? []) {
    lines.push(`  ${positional.name}${positional.choices ? ` {${positional.choices.join(",")}}` : ""}`);
  }
  for (const option of spec.options) {
    if (option.hidden) continue;
    const details = [
      option.help,
      option.choices ? `one of: ${option.choices.join(", ")}` : null,
      option.default !== undefined && option.type !== "boolean" ? `default: ${option.default}` : null,
      option.multiple ? "repeatable" : null,
    ].filter(Boolean);
    lines.push(`  --${option.name}${details.length ? `  ${details.join("; ")}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The package version, so a skill can tell which CLI it is talking to. */
function version(): string {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

function mainHelp(specs: Record<string, CommandSpec>): string {
  const lines = [
    `usage: webhand {${Object.keys(specs).join(",")}} ...`,
    "",
    "CLI for the Claude + Jev agent. Each call is one short process.",
    "",
  ];
  for (const [name, spec] of Object.entries(specs)) lines.push(`  ${name.padEnd(9)} ${spec.help}`);
  lines.push(
    "",
    "  --version  Print the version",
    "  --help     Print this help; COMMAND --help prints a command's options",
  );
  return `${lines.join("\n")}\n`;
}

export interface Parsed {
  command: string;
  args: Args;
  run: (args: Args) => Promise<number>;
}

/** Parses argv, with argparse-style messages. Throws UsageError, or returns help text to print. */
export function parse(argv: string[]): Parsed | { help: string } {
  const specs = commands();
  const [name, ...rest] = argv;
  if (name === undefined) throw new UsageError(`the following arguments are required: command\n${mainHelp(specs)}`);
  if (name === "-h" || name === "--help") return { help: mainHelp(specs) };
  if (name === "-V" || name === "--version") return { help: `${version()}\n` };
  const spec = specs[name];
  if (!spec) throw new UsageError(`argument command: invalid choice: ${quote(name)}`);
  const args: Args = {};
  const positionals: string[] = [];
  const byName = new Map(spec.options.map((option) => [option.name, option]));
  for (const option of spec.options) {
    const key = option.name.replaceAll("-", "_");
    args[key] = option.multiple ? [] : option.type === "boolean" ? false : (option.default ?? null);
  }
  const fail = (message: string) => new UsageError(`${usage(name, spec)}\nwebhand ${name}: error: ${message}`);
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "-h" || token === "--help") return { help: help(name, spec) };
    if (token === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (!token.startsWith("--") || token === "-") {
      positionals.push(token);
      continue;
    }
    const at = token.indexOf("=");
    const optionName = at < 0 ? token.slice(2) : token.slice(2, at);
    const option = byName.get(optionName);
    if (!option) throw fail(`unrecognized arguments: ${token}`);
    const key = option.name.replaceAll("-", "_");
    seen.add(option.name);
    if (option.type === "boolean") {
      if (at >= 0) throw fail(`argument --${option.name}: ignored explicit argument ${quote(token.slice(at + 1))}`);
      args[key] = true;
      continue;
    }
    let raw: string;
    if (at >= 0) raw = token.slice(at + 1);
    else {
      const next = rest[i + 1];
      if (next === undefined || (next.startsWith("-") && next.length > 1 && !/^-\d/.test(next))) {
        throw fail(`argument --${option.name}: expected one argument`);
      }
      raw = next;
      i++;
    }
    let value: unknown = raw;
    if (option.type === "int") {
      if (!/^\s*[-+]?\d+\s*$/.test(raw)) throw fail(`argument --${option.name}: invalid int value: ${quote(raw)}`);
      value = Number.parseInt(raw, 10);
    } else if (option.type === "float") {
      const number = Number(raw);
      if (!raw.trim() || Number.isNaN(number)) {
        throw fail(`argument --${option.name}: invalid float value: ${quote(raw)}`);
      }
      value = number;
    }
    if (option.choices && !option.choices.includes(String(value))) {
      throw fail(
        `argument --${option.name}: invalid choice: ${quote(value)} (choose from ${option.choices.map(quote).join(", ")})`,
      );
    }
    if (option.multiple) args[key].push(value);
    else args[key] = value;
  }
  const declared = spec.positionals ?? [];
  const missing = declared.filter((p, i) => !p.optional && positionals[i] === undefined);
  if (missing.length) {
    throw fail(`the following arguments are required: ${missing.map((p) => p.name).join(", ")}`);
  }
  if (positionals.length > declared.length) {
    throw fail(`unrecognized arguments: ${positionals.slice(declared.length).join(" ")}`);
  }
  declared.forEach((positional, i) => {
    const value = positionals[i] ?? null;
    if (value !== null && positional.choices && !positional.choices.includes(value)) {
      throw fail(
        `argument ${positional.name}: invalid choice: ${quote(value)} (choose from ${positional.choices.map(quote).join(", ")})`,
      );
    }
    args[positional.name] = value;
  });
  const required = spec.options.filter((option) => option.required && !seen.has(option.name));
  if (required.length) {
    throw fail(`the following arguments are required: ${required.map((option) => `--${option.name}`).join(", ")}`);
  }
  return { command: name, args, run: spec.run };
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
export async function main(argv: string[], io: IO = processIO): Promise<number> {
  const parsed = parse(argv);
  if ("help" in parsed) {
    io.out(parsed.help);
    return OK;
  }
  context = { out: [], err: io.err, log: null };
  const current = context;
  // What Claude must read is a real cost of this design, so every handoff is sized and logged.
  try {
    return await parsed.run(parsed.args);
  } finally {
    const text = current.out.join("");
    io.out(text);
    if (current.log) logOnce(current.log, "handoff", { command: parsed.command, chars: [...text].length });
  }
}
