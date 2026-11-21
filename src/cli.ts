/**
 * CLI for the Claude + Jev agent. Each call is one short process.
 *
 * Claude plans the goal, steps, and values, reviews the outcome, and replans. Jev chooses every
 * operation toward the goal and hands control back only when it cannot continue on its own.
 *
 * The commands are in commands/; this file declares them (options, help) and runs one.
 */

import { Budget } from "./agent.ts";
import { type Args, type CommandSpec, type OptionSpec, type Parsed, parse as parseArgs } from "./args.ts";
import { commandAct } from "./commands/act.ts";
import { commandAnswer } from "./commands/answer.ts";
import { commandAuth } from "./commands/auth.ts";
import { commandCatalog } from "./commands/catalog.ts";
import { commandCheck } from "./commands/check.ts";
import { CliExit, getContext, type Hooks, OK, setContext } from "./commands/context.ts";
import { commandFinish } from "./commands/finish.ts";
import { commandKnowledge } from "./commands/knowledge.ts";
import { commandLearn } from "./commands/learn.ts";
import { commandObserve } from "./commands/observe.ts";
import { commandProfile } from "./commands/profile.ts";
import { commandReplan } from "./commands/replan.ts";
import { commandRun } from "./commands/run.ts";
import { FLOWS } from "./commands/shared.ts";
import { commandStart } from "./commands/start.ts";
import { CHROMES } from "./engines/chrome.ts";
import { ENGINE_CHOICES } from "./engines/index.ts";
import { logOnce } from "./metrics.ts";
import * as runbook from "./runbook.ts";
import * as session from "./session.ts";

const DEFAULT_ATTEMPTS = 3;

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
        {
          name: "file",
          type: "string",
          multiple: true,
          metavar: "LABEL=PATH",
          help: "A file Jev may upload (under the current directory)",
        },
        { name: "download-dir", type: "string", help: "Save files the page downloads here (local Chrome only)" },
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
        {
          name: "file",
          type: "string",
          multiple: true,
          metavar: "LABEL=PATH",
          help: "A file Jev may upload (under the current directory)",
        },
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
        {
          name: "file",
          type: "string",
          multiple: true,
          metavar: "LABEL=PATH",
          help: "A file Jev may upload (under the current directory)",
        },
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
        {
          name: "file",
          type: "string",
          multiple: true,
          metavar: "LABEL=PATH",
          help: "A file Jev may upload (under the current directory)",
        },
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
      options: [
        idOption,
        { name: "text", type: "string" },
        { name: "file", type: "string", help: "UPLOAD_FILE: the label of one of the plan's files" },
      ],
      positionals: [{ name: "operation" }, { name: "target", optional: true }],
      run: commandAct,
    },
    observe: { help: "Print the current page", options: [idOption], run: commandObserve },
    check: {
      help: "Claude: compare expectations with the page as it is now (read-only; evidence, not the verdict)",
      options: [
        idOption,
        {
          name: "expect",
          type: "string",
          multiple: true,
          required: true,
          metavar: "KIND:ARGS",
          help: "text:S, no-text:S, field:LABEL=V, checked:LABEL=true|false, count:ROLE=N, url:/path, title:S",
        },
        {
          name: "read",
          type: "boolean",
          help: "Read the text of the whole page beyond the viewport for this check only (no replan, no attempt used)",
        },
      ],
      run: commandCheck,
    },
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
const SESSION_COMMANDS = ["start", "run", "answer", "replan", "act", "observe", "check", "finish"];

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
  setContext({ out: [], err: io.err, log: null, hooks });
  const current = getContext();
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
