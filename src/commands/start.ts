import { resolve } from "node:path";
import * as agent from "../agent/index.ts";
import { Budget } from "../agent/index.ts";
import type { Args } from "../args.ts";
import { describeError, quote } from "../core/format.ts";
import { gitState, maskUrls, pageEvent, Recorder, safeUrl } from "../core/metrics.ts";
import type { Plan, Step, Value } from "../core/types.ts";
import { browserUrl, chooseChrome as pickChrome } from "../engines/chrome.ts";
import { chooseEngine, engineFor, hostName } from "../engines/index.ts";
import type { Engine } from "../engines/types.ts";
import { hostAllowed, parseAllow } from "../explore.ts";
import { type HarState, startHarRecorder, stopHarRecorder } from "../har/session.ts";
import type { Driver } from "../ipc/remote.ts";
import { describePlan, headline } from "../output.ts";
import { planText } from "../policies/base.ts";
import * as auth from "../storage/auth.ts";
import * as batch from "../storage/batch.ts";
import * as runbook from "../storage/runbook/index.ts";
import * as session from "../storage/session.ts";
import { CliExit, deps, getContext, named, OK, print } from "./context.ts";
import {
  allowControlOption,
  chromeOption,
  collectOption,
  compareOption,
  engineOption,
  fileOption,
  idOption,
  moreOption,
  valueOption,
  viewOptions,
} from "./options.ts";
import { attach, browserView, defaultLog, FLOWS, mergeValues, parseFiles, parseSteps, parseValues } from "./shared.ts";
import type { CommandDef } from "./types.ts";

const DEFAULT_ATTEMPTS = 3;

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
  engine: Engine;
  login: auth.SavedLogin | null;
  batchRow: batch.ResolvedBatchRow | null;
  resolvedParams: Record<string, string>;
}

/** The runbook, service, saved login, engine and Chrome the arguments ask for. Nothing is opened. */
function resolveTarget(args: Args): StartTarget {
  if (args.row != null && !args.batch) {
    throw new CliExit("--row needs --batch");
  }
  let book: runbook.Runbook | null = null;
  let batchRow: batch.ResolvedBatchRow | null = null;
  let resolvedParams: Record<string, string> = {};
  if (args.batch) {
    batchRow = batch.resolveBatchRow(args.batch, args.row);
    resolvedParams = { ...batchRow.params, ...runbook.parseValues(args.param) };
    book = runbook.load(batchRow.state.runbook, resolvedParams);
    if (book.status !== "approved" && !batchRow.state.allow_draft && !args.allow_draft) {
      throw new CliExit(
        `Runbook ${batchRow.state.runbook} is a draft. Trial it with --allow-draft, then get it approved`,
      );
    }
  } else if (args.runbook) {
    resolvedParams = runbook.parseValues(args.param);
    book = runbook.load(args.runbook, resolvedParams);
    if (book.status !== "approved" && !args.allow_draft) {
      throw new CliExit(`Runbook ${args.runbook} is a draft. Trial it with --allow-draft, then get it approved`);
    }
  }
  const serviceName = args.service || (book ? book.service : null);
  const service = serviceName ? runbook.loadService(serviceName) : null;
  const profile = session.parseSession(args.session);
  const login = args.auth ? loadLogin(args.auth, profile) : null;
  const engineId = chooseEngine(args.engine, { headed: args.headed, profile, chrome: args.chrome });
  const engine = engineFor(engineId);
  // --chrome says where Chrome runs; the other engines have no such choice.
  const [chrome, note] = engine.id === "chrome" ? pickChrome(args.chrome) : ["linux", null];
  checkExplore(args, profile, engine, chrome);
  if ((args.download_dir || args.file.length) && !engine.capabilities.localFiles) {
    throw new CliExit("--file and --download-dir need a local Chrome (--engine chrome or headless-shell)");
  }
  if (args.har && !engine.capabilities.har) {
    throw new CliExit("--har needs Chrome or headless-shell (--engine chrome or headless-shell)");
  }
  if (args.download_dir && chrome !== "linux") {
    throw new CliExit("--download-dir needs Chrome on this machine: the Windows Chrome cannot save to its paths");
  }
  return { book, service, serviceName, profile, chrome, note, engine, login, batchRow, resolvedParams };
}

/**
 * Exploring stays in a test environment: a new session on a local Chrome, with the hosts it may visit named, and a
 * limit on actions in all. A saved profile (profile:NAME) is never used; a login saved by `auth save` (--auth) may be,
 * for a test account, and a file may be attached.
 */
function checkExplore(args: Args, profile: string | null, engine: Engine, chrome: string): void {
  if (!args.explore) {
    if (args.allow_domain.length || args.max_total_actions != null) {
      throw new CliExit("--allow-domain and --max-total-actions are for --explore");
    }
    return;
  }
  if (profile) {
    throw new CliExit(
      "--explore does not use a saved profile (profile:NAME). Start from a test account's login: --auth NAME",
    );
  }
  if (args.read_only) throw new CliExit("--explore and --read-only are different postures: use one");
  if (!engine.capabilities.explore || chrome !== "linux") {
    throw new CliExit(
      "--explore needs a local Chrome on this machine (--engine chrome or headless-shell, --chrome linux)",
    );
  }
  if (args.max_total_actions == null || args.max_total_actions < 1) {
    throw new CliExit("--explore needs --max-total-actions N: how many actions the whole session may take");
  }
  exploreRule(args);
}

/** The session's explore rule from the arguments. */
function exploreRule(args: Args): { allow: string[]; max_total: number } {
  return { allow: parseAllow(args.allow_domain), max_total: args.max_total_actions };
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
    // Runbook parameters (including batch row params) are Claude's values too, unless Claude labelled them itself.
    const params = Object.entries(target.resolvedParams).map(([label, value]) => ({ label, value }));
    values = mergeValues(params, values);
  }
  if (args.explore && !hostAllowed(url, exploreRule(args).allow)) {
    throw new CliExit("The start URL is outside --allow-domain: exploring only visits the hosts it was given");
  }
  if (!args.explore && service?.allowed_domains?.length && !hostAllowed(url, service.allowed_domains)) {
    throw new CliExit(
      `The start URL is outside service ${service.service}'s allowed_domains (${service.allowed_domains.join(", ")})`,
    );
  }
  if (args.allow_control.length && !args.read_only) throw new CliExit("--allow-control needs --read-only");
  if (args.read_only && steps.some((step) => step.actor === "human")) {
    throw new CliExit("A read-only session has no [person] steps: start from a saved login (--auth or profile:NAME)");
  }
  if (args.read_only && files.length) throw new CliExit("A read-only session cannot upload files");
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
  harState: HarState | null,
): session.State {
  const { book, service, serviceName, chrome } = target;
  const hooks = getContext().hooks;
  const task = hooks.task ?? null;
  const saved = runbook.view(runbook.serviceView(service), book);
  const claudeView = { focus: args.focus, skip: args.skip, read: args.read };
  return {
    ...chromeState,
    view_saved: saved,
    view_claude: claudeView,
    view: runbook.view(saved, claudeView),
    task,
    start_url: browserUrl(planned.url, chrome),
    ...(args.download_dir ? { download_dir: resolve(args.download_dir) } : {}),
    ...(harState ? { har: harState } : {}),
    ...(hooks.meta ? { meta: hooks.meta } : {}),
    ...(args.read_only ? { read_only: { allow: args.allow_control } } : {}),
    ...(args.explore ? { explore: exploreRule(args) } : {}),
    ...(!args.explore && service?.allowed_domains?.length ? { allowed_domains: service.allowed_domains } : {}),
    ...(target.batchRow
      ? { batch: { id: target.batchRow.state.id, row: target.batchRow.row, total: target.batchRow.total } }
      : {}),
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
    log: hooks.log ?? defaultLog(task || "adhoc"),
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
      ...(engine.id !== "chrome" ? { engine: engine.id } : {}),
      session: profile ? "profile" : "new",
      ...(args.auth ? { auth: args.auth } : {}),
      ...(state.har ? { har: true } : {}),
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
      ...(args.read_only ? { read_only: { allow: args.allow_control } } : {}),
      ...(state.explore ? { explore: state.explore } : {}),
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
      ...(engine.id !== "chrome" ? { engine: engine.id } : {}),
      session: profile ? "profile" : "new",
      started_at: new Date().toISOString(),
    });
    if (state.har) await stopHarRecorder(state.har);
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
  if (note) print(`NOTE: ${note}`);
  if (engine.notes?.start) print(`NOTE: ${engine.notes.start}`);
  if (args.auth) {
    print(`SIGNED IN with saved login ${args.auth}. Pages opened signed in are sent to Jev`);
    if (engine.notes?.auth) print(`NOTE: ${engine.notes.auth}`);
    if (skipped.length) print(`NOTE: localStorage of other sites was not restored: ${skipped.join(", ")}`);
  }
  print(
    `${describePlan(plan, state.view)}\nSESSION: ${args.session} (${hostName(engine.id, chrome)})\n${headline(state.page)}`,
  );
  if (state.read_only) {
    const allow: string[] = state.read_only.allow;
    print(
      `READ-ONLY: actions that submit a non-GET form, attach a file, or press a button outside any form are refused${allow.length ? ` (allowed buttons: ${allow.map((a) => quote(a)).join(", ")})` : ""}. Nothing else is guaranteed`,
    );
  }
  if (state.explore) {
    print(
      `EXPLORING: requests to hosts other than ${state.explore.allow.join(", ")} are refused. At most ${state.explore.max_total} actions in all. Anomalies are candidates, not verdicts: after each run or act, webhand findings`,
    );
  }
  if (state.allowed_domains?.length) {
    print(`ALLOWED DOMAINS: ${state.allowed_domains.join(", ")} (navigations outside this list are refused)`);
  }
  if (state.har) {
    print(`HAR: recording to ${state.har.path} (contains cookies and page traffic; do not commit)`);
  }
  if (state.batch) {
    print(`BATCH: ${state.batch.id} row ${state.batch.row}/${state.batch.total}`);
  }
  print("NEXT: webhand run");
}

async function commandStart(args: Args): Promise<number> {
  if (session.load()) {
    throw new CliExit(named("A session is active. Run: webhand finish --status abandoned, or start another with --id"));
  }
  const target = resolveTarget(args);
  const planned = planStart(args, target);
  const chromeState = await deps.startChrome({
    headed: args.headed,
    profile: target.profile,
    chrome: target.chrome,
    engine: target.engine.id,
  });
  let harState: HarState | null = null;
  try {
    await getContext().hooks.beforeStart?.(chromeState);
    if (args.har) {
      harState = await startHarRecorder(chromeState.port, resolve(args.har));
    }
  } catch (error) {
    if (harState) await stopHarRecorder(harState);
    await session.stopChrome(chromeState);
    throw error;
  }
  const state = initialState(args, target, planned, chromeState, harState);
  getContext().log = state.log;
  const skipped = await openStartPage(args, target, planned, chromeState, state);
  session.save(state);
  if (target.batchRow) batch.markRowRunning(target.batchRow.state.id, target.batchRow.row);
  printStarted(args, target, planned.plan, state, skipped);
  return OK;
}

export const startCommand: CommandDef = {
  name: "start",
  session: "required",
  spec: () => ({
    help: "Record Claude's plan and open the start page",
    options: [
      idOption(),
      { name: "goal", type: "string" },
      { name: "url", type: "string" },
      { name: "step", type: "string", multiple: true, help: 'A plan step. "[person] ..." is done by a person' },
      valueOption("Text Jev may type"),
      fileOption(),
      { name: "download-dir", type: "string", help: "Save files the page downloads here (local Chrome only)" },
      {
        name: "har",
        type: "string",
        metavar: "PATH",
        help: "Record HTTP traffic of the session to a HAR 1.2 file (Chrome or headless-shell only; contains cookies and page data)",
      },
      {
        name: "read-only",
        type: "boolean",
        help: "Refuse actions it can tell may change something: a non-GET form submit, a file, a button outside a form",
      },
      allowControlOption(),
      {
        name: "explore",
        type: "boolean",
        help: "Look for faults in a test environment: refuse requests outside --allow-domain, note console errors, 5xx and dead ends (webhand findings)",
      },
      {
        name: "allow-domain",
        type: "string",
        multiple: true,
        metavar: "HOST",
        help: "With --explore, a host the session may reach (and its subdomains), such as shop.test or localhost:8080",
      },
      {
        name: "max-total-actions",
        type: "int",
        metavar: "N",
        help: "With --explore, the most actions the whole session may take, across attempts",
      },
      { name: "service", type: "string", help: "Saved service information to give Jev, such as hotel-site" },
      { name: "runbook", type: "string", help: "A saved procedure (runbook), such as hotel/filter" },
      {
        name: "batch",
        type: "string",
        metavar: "ID",
        help: "Run the next pending row (or --row N) of a batch created by `webhand batch init`",
      },
      { name: "row", type: "int", metavar: "N", help: "With --batch, run this 1-based row number" },
      { name: "param", type: "string", multiple: true, metavar: "KEY=VALUE", help: "A runbook parameter" },
      { name: "allow-draft", type: "boolean", help: "Trial a runbook no person has approved yet" },
      ...viewOptions(),
      compareOption(),
      collectOption(),
      moreOption(),
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
      chromeOption(),
      engineOption(),
      { name: "headed", type: "boolean" },
      { name: "max-attempts", type: "int", default: DEFAULT_ATTEMPTS },
      { name: "max-actions", type: "int", default: Budget.MAX_ACTIONS, help: "Per attempt" },
      { name: "max-decisions", type: "int", default: Budget.MAX_DECISIONS, help: "Per attempt" },
    ],
    conflicts: [
      ["auth", "id"],
      ["batch", "runbook"],
    ],
  }),
  run: commandStart,
};
