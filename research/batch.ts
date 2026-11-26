/**
 * Runs research tasks one at a time, each in a new interactive Claude Code session in its own herdr tab, and appends
 * one line per run to DIR/results.jsonl. Not shipped. Run from the repository root:
 * `node research/batch.ts --tasks A,B --repeat N --model MODEL --out DIR [--full]`
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { listTasks } from "./tasks.ts";

const TIMEOUT_MS = 20 * 60_000;
const SETTLE_MS = 60_000; // After run_end, how long the host may take to write its report (its tokens count too).
const POLL_MS = 5_000;
const TOKENS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const;
type Tokens = Record<(typeof TOKENS)[number], number>;
// biome-ignore lint/suspicious/noExplicitAny: log, transcript and result lines are untyped JSON.
type Json = any;
/** The same for lean and full. Without the session named, the webhand skill asks for it and nothing answers. */
const prompt = (task: string) => `/webhand-research ${task} (session: new)`;

export interface Deps {
  herdr(args: string[]): string;
  sleep(ms: number): Promise<unknown>;
  now(): number;
  claudeDir: string;
  claudeVersion(): string;
  out(text: string): void;
}

const defaults: Deps = {
  herdr: (args) => execFileSync("herdr", args, { encoding: "utf8" }),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: Date.now,
  claudeDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  claudeVersion: () => execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
  out: (text) => process.stdout.write(`${text}\n`),
};

/** The entries of a folder; none when it is missing or is a file. */
const list = (dir: string): string[] =>
  statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(dir) : [];
const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

function jsonLines(file: string): Json[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return line ? [JSON.parse(line)] : [];
      } catch {
        return []; // A line still being written.
      }
    });
}

/** The host's usage from the session's transcripts; a message is written once per content block, so count it once. */
function tokens(claudeDir: string, session: string): Tokens | null {
  const projects = join(claudeDir, "projects");
  const files = list(projects).flatMap((project) => {
    const base = join(projects, project, session);
    const agents = list(join(base, "subagents")).map((name) => join(base, "subagents", name));
    return [`${base}.jsonl`, ...agents].filter((file) => existsSync(file));
  });
  const usage = new Map<string, Partial<Tokens>>();
  for (const line of files.flatMap(jsonLines)) {
    if (line.type === "assistant" && line.message?.usage) usage.set(line.message.id, line.message.usage);
  }
  if (usage.size === 0) return null;
  const sum = (key: keyof Tokens) => [...usage.values()].reduce((total, one) => total + (one[key] ?? 0), 0);
  return Object.fromEntries(TOKENS.map((key) => [key, sum(key)])) as Tokens;
}

function runEnd(home: string, task: string): Json {
  for (const stamp of list(join(home, "runs"))) {
    const log = join(home, "runs", stamp, `${task}.jsonl`);
    const event = jsonLines(log).find((line) => line.type === "run_end");
    if (event) return { ...event, log };
  }
  return null;
}

/** One run: opens a tab, starts claude there, waits for run_end or the time limit, and closes only that pane. */
async function runTask(task: string, home: string, model: string, full: boolean, deps: Deps) {
  const session = randomUUID();
  const started = deps.now();
  let pane: string | null = null;
  let launched = false;
  let end: Json = null;
  let blocked = false;
  let reason = "timeout";
  let error: string | undefined;
  try {
    mkdirSync(home, { recursive: true });
    const env = { WEBHAND_HOME: home, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
    // env goes into --settings too: a project's settings would otherwise override the process environment.
    // Without the user source, ~/.claude/CLAUDE.md is still found as a project file when the repository is under home.
    const claudeMdExcludes = [join(homedir(), ".claude", "**")];
    // Turned off so that no "Teach auto mode about your environment?" dialog opens once the work is done.
    const skillOverrides = { "auto-mode-setup": "off" };
    const lean = full ? {} : { disableBundledSkills: true };
    const settings = JSON.stringify({ env, claudeMdExcludes, skillOverrides, ...lean });
    const command = [
      "env",
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      // The prompt comes first: --tools takes several values and would swallow it.
      ...["claude", prompt(task), "--model", model, "--session-id", session, "--strict-mcp-config"],
      // The user's settings are left out, so the permission mode they might set is named here.
      ...["--setting-sources", "project", "--permission-mode", "auto"],
      ...(full ? [] : ["--tools", "Bash,Read,AskUserQuestion,Skill"]),
      ...["--settings", settings],
    ];
    const args = ["tab", "create", "--cwd", process.cwd(), "--label", `batch-${task}`, "--no-focus"];
    pane = JSON.parse(deps.herdr(args)).result.root_pane.pane_id as string;
    deps.herdr(["pane", "run", pane, command.map(quote).join(" ")]);
    launched = true;
    const status = () => JSON.parse(deps.herdr(["pane", "get", pane as string])).result.pane.agent_status;
    let state = "";
    while (!end && deps.now() - started < TIMEOUT_MS) {
      await deps.sleep(POLL_MS);
      end = runEnd(home, task);
      state = status();
      blocked ||= state === "blocked"; // A question or a permission prompt. Nothing answers it here.
    }
    if (end) {
      reason = "run_end";
      const limit = deps.now() + SETTLE_MS;
      while (state === "working" && deps.now() < limit) {
        await deps.sleep(POLL_MS);
        state = status();
        blocked ||= state === "blocked";
      }
    } else if (state === "blocked") reason = "needs_input";
  } catch (caught) {
    if (!end) reason = launched ? "herdr_error" : "launch_failed";
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const duration = deps.now() - started;
  if (pane) {
    try {
      deps.herdr(["pane", "close", pane]);
    } catch {
      deps.out(`WARNING: could not close pane ${pane}`);
    }
  }
  return {
    verified: end?.verified ?? null,
    attempts: end?.attempts ?? null,
    duration_ms: duration,
    tokens: tokens(deps.claudeDir, session),
    end_reason: reason,
    blocked,
    session_id: session,
    log: end?.log ?? null,
    ...(error ? { error } : {}),
  };
}

function claudeVersion(deps: Deps): string | null {
  try {
    return deps.claudeVersion();
  } catch {
    return null; // The launch will record its own failure.
  }
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).trim();

export async function batch(argv: string[], deps: Deps = defaults): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      tasks: { type: "string" },
      repeat: { type: "string", default: "1" },
      model: { type: "string" },
      out: { type: "string" },
      full: { type: "boolean", default: false },
    },
  });
  const { model, full } = values;
  const repeat = Number(values.repeat);
  if (!values.tasks || !model || !values.out || !Number.isInteger(repeat) || repeat < 1) {
    throw new Error("usage: node research/batch.ts --tasks A,B --repeat N --model MODEL --out DIR [--full]");
  }
  const tasks = values.tasks.split(",");
  const unknown = tasks.filter((task) => !listTasks().includes(task));
  if (unknown.length > 0) throw new Error(`Unknown task: ${unknown.join(", ")} (run from the repository root)`);
  const out = resolve(values.out);
  const results = join(out, "results.jsonl");
  if (!relative(process.cwd(), out).startsWith("..")) {
    try {
      git("check-ignore", "-q", results);
    } catch {
      throw new Error("--out must be outside the repository or ignored by git");
    }
  }
  deps.herdr(["pane", "list"]); // Stops here, with nothing recorded, when herdr is not available.
  mkdirSync(out, { recursive: true });
  const profile = full ? "full" : "lean";
  const rows: Json[] = [];
  for (let n = 1; n <= repeat; n++) {
    for (const task of tasks) {
      const key = { task, n, profile, model };
      let row = jsonLines(results).find((one) => Object.entries(key).every(([k, v]) => one[k] === v));
      if (!row) {
        // A new home for every run, so a log left by an interrupted run is never taken for this one.
        const home = join(out, "homes", `${task}-${n}-${randomUUID().slice(0, 8)}`);
        deps.out(`RUN ${task} #${n} (${profile})`);
        const commit = git("rev-parse", "HEAD");
        const versions = { claude_version: claudeVersion(deps), batch_node_version: process.version };
        row = { ...key, commit, ...versions, ...(await runTask(task, home, model, full, deps)) };
        appendFileSync(results, `${JSON.stringify(row)}\n`);
        deps.out(`  verified=${row.verified} end_reason=${row.end_reason} blocked=${row.blocked}`);
      }
      rows.push(row);
    }
  }
  const passed = rows.filter((row) => row.verified === true).length;
  const total = (key: keyof Tokens) => rows.reduce((sum, row) => sum + (row.tokens?.[key] ?? 0), 0);
  deps.out(`VERIFIED ${passed}/${rows.length} (${Math.round((100 * passed) / rows.length)}%)`);
  deps.out(`TOKENS ${TOKENS.map((key) => `${key}=${total(key)}`).join(" ")}`);
  const missing = rows.filter((row) => !row.tokens).length;
  if (missing > 0) deps.out(`TOKENS missing for ${missing} run(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await batch(process.argv.slice(2));
}
