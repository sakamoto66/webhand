import { resolve } from "node:path";
import * as agent from "../agent.ts";
import type { Args } from "../args.ts";
import * as auth from "../auth.ts";
import { browserUrl, chooseChrome as pickChrome } from "../engines/chrome.ts";
import { chooseEngine, engineFor, hostName } from "../engines/index.ts";
import { describeError } from "../format.ts";
import { gitState, maskUrls, pageEvent, Recorder, safeUrl } from "../metrics.ts";
import { describePlan, headline } from "../output.ts";
import { planText } from "../policies/base.ts";
import type { Driver } from "../remote.ts";
import * as runbook from "../runbook.ts";
import * as session from "../session.ts";
import type { Plan, Step, Value } from "../types.ts";
import { CliExit, deps, getContext, named, OK, print } from "./context.ts";
import { attach, browserView, defaultLog, FLOWS, mergeValues, parseFiles, parseSteps, parseValues } from "./shared.ts";

export function chooseChrome(choice: string): [string, string | null] {
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
    if ((args.download_dir || args.file.length) && !["chrome", "headless-shell"].includes(engine)) {
      throw new CliExit("--file and --download-dir need a local Chrome (--engine chrome or headless-shell)");
    }
    if (args.download_dir && chrome !== "linux") {
      throw new CliExit("--download-dir needs Chrome on this machine: the Windows Chrome cannot save to its paths");
    }
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
  const files = parseFiles(args.file);
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
    ...(files.length ? { files } : {}),
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
  const task = getContext().hooks.task ?? null;
  const learned = runbook.view(runbook.serviceView(service), book);
  const claudeView = { focus: args.focus, skip: args.skip, read: args.read };
  return {
    ...chromeState,
    view_learned: learned,
    view_claude: claudeView,
    view: runbook.view(learned, claudeView),
    task,
    start_url: browserUrl(planned.url, chrome),
    ...(args.download_dir ? { download_dir: resolve(args.download_dir) } : {}),
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
      ...(plan.files ? { files: plan.files.map((f) => f.label) } : {}),
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

export async function commandStart(args: Args): Promise<number> {
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
  getContext().log = state.log;
  const skipped = await openStartPage(args, target, planned, chromeState, state);
  session.save(state);
  printStarted(args, target, planned.plan, state, skipped);
  return OK;
}
