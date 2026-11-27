/**
 * Runs research tasks (tasks/ or WebArena-Verified), each in a new interactive Claude Code session, in a new herdr
 * tab with --parallel panes and a research/progress.ts pane, and appends one line per run to DIR/results.jsonl.
 * Not shipped. Run from the repository root:
 * `node research/batch.ts (--tasks A,B | --webarena 0,11) --model MODEL --out DIR [--repeat N] [--parallel N]
 * [--serial A,B] [--full]`
 * --serial names the tasks that run one at a time after all the others (those that change data a site shares).
 * It stops on uncommitted files, and when DIR/results.jsonl or the next run is not on the commit it started on.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { listTasks } from "./tasks.ts";
import { loadConfig } from "./webarena/config.ts";
import { listTasksPublic, resolveDatasetPath } from "./webarena/dataset.ts";

const TIMEOUT_MS = 20 * 60_000;
const SETTLE_MS = 60_000; // After run_end, how long the host may take to write its report (its tokens count too).
const POLL_MS = 5_000;
const TOKENS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const;
type Tokens = Record<(typeof TOKENS)[number], number>;
// biome-ignore lint/suspicious/noExplicitAny: log, transcript and result lines are untyped JSON.
type Json = any;
const AUTO_ANSWER = join(import.meta.dirname, "auto-answer.ts");

interface Job {
  /** The name in results.jsonl and in the run log: a tasks/ name, or webarena_ID. */
  task: string;
  /** The WebArena task ID; null for a tasks/ task. */
  id: number | null;
}

/** The same for lean and full. Without the session named, the webhand skill asks for it and nothing answers. */
const prompt = (job: Job, out: string) =>
  job.id === null
    ? `/webhand-research ${job.task} (session: new)`
    : `/webhand-webarena-research ${job.id} (session: new) Pass --out-dir ${out} to start. Do not pass --eval.`;

export interface Deps {
  herdr(args: string[]): string;
  sleep(ms: number): Promise<unknown>;
  now(): number;
  claudeDir: string;
  claudeVersion(): string;
  /** The IDs in the WebArena dataset. */
  webarenaIds(): number[];
  /** Runs research/webarena.ts and returns its output. */
  webarena(args: string[]): string;
  git(...args: string[]): string;
  out(text: string): void;
}

const defaults: Deps = {
  herdr: (args) => execFileSync("herdr", args, { encoding: "utf8" }),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: Date.now,
  claudeDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  claudeVersion: () => execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
  webarenaIds: () => {
    const { config } = loadConfig(null);
    return listTasksPublic(resolveDatasetPath(config, null), config).tasks.map((task) => task.task_id);
  },
  webarena: (args) => execFileSync("node", ["research/webarena.ts", ...args], { encoding: "utf8" }),
  git: (...args) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).trim(),
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

/** The run_end lines of a run's log: DIR/ID/webhand.jsonl for WebArena, else HOME/runs/STAMP/TASK.jsonl. */
function runEnds(job: Job, home: string, out: string): Json[] {
  const logs =
    job.id === null
      ? list(join(home, "runs")).map((stamp) => join(home, "runs", stamp, `${job.task}.jsonl`))
      : [join(out, String(job.id), "webhand.jsonl")];
  return logs.flatMap((log) =>
    jsonLines(log)
      .filter((line) => line.type === "run_end")
      .map((line) => ({ ...line, log })),
  );
}

interface Options {
  model: string;
  full: boolean;
  out: string;
}

/** The --settings of one run. */
function settings(job: Job, env: Record<string, string>, { full, out }: Options): string {
  // env goes into --settings too: a project's settings would otherwise override the process environment.
  // Without the user source, ~/.claude/CLAUDE.md is still found as a project file when the repository is under home.
  const claudeMdExcludes = [join(homedir(), ".claude", "**")];
  // Turned off so that no "Teach auto mode about your environment?" dialog opens once the work is done.
  const skillOverrides = { "auto-mode-setup": "off" };
  const lean = full ? {} : { disableBundledSkills: true };
  const answer = { type: "command", command: `node ${JSON.stringify(AUTO_ANSWER)}` };
  const hooks = { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [answer] }] };
  // The files that hold expected answers or sign-ins, and other runs' records.
  const secrets = [env.WEBARENA_DATASET, env.WEBARENA_CONFIG].filter(Boolean);
  const folders = [resolve("state"), join(homedir(), ".webhand", "state"), join(homedir(), ".webhand", "runs"), out];
  const deny = [
    ...secrets.map((file) => `Read(/${file})`),
    ...folders.map((folder) => `Read(/${folder}/**)`),
    "Bash(*webarena-verified*.json*)",
    "Bash(*eval_result.json*)",
  ];
  const permissions = job.id === null ? {} : { permissions: { deny } };
  return JSON.stringify({ env, claudeMdExcludes, skillOverrides, hooks, ...permissions, ...lean });
}

/** One run: starts claude in the pane and waits for run_end or the time limit. The caller replaces the pane. */
async function runTask(job: Job, home: string, pane: string, options: Options, deps: Deps) {
  const { model, full, out } = options;
  const session = randomUUID();
  const started = deps.now();
  let launched = false;
  let end: Json = null;
  let blocked = false;
  let reason = "timeout";
  let error: string | undefined;
  try {
    mkdirSync(home, { recursive: true });
    const env: Record<string, string> = { WEBHAND_HOME: home, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
    if (job.id !== null) {
      for (const name of ["WEBARENA_DATASET", "WEBARENA_CONFIG"]) {
        const value = process.env[name];
        if (value) env[name] = resolve(value);
      }
    }
    const command = [
      "env",
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      // The prompt comes first: --tools takes several values and would swallow it.
      ...["claude", prompt(job, out), "--model", model, "--session-id", session, "--strict-mcp-config"],
      // The user's settings are left out, so the permission mode they might set is named here.
      ...["--setting-sources", "project", "--permission-mode", "auto"],
      ...(full ? [] : ["--tools", "Bash,Read,AskUserQuestion,Skill"]),
      ...["--settings", settings(job, env, options)],
    ];
    // An earlier, interrupted run of a WebArena task leaves its log in the same folder.
    const before = runEnds(job, home, out).length;
    deps.herdr(["pane", "run", pane, command.map(quote).join(" ")]);
    launched = true;
    const status = () => JSON.parse(deps.herdr(["pane", "get", pane])).result.pane.agent_status;
    let state = "";
    while (!end && deps.now() - started < TIMEOUT_MS) {
      await deps.sleep(POLL_MS);
      end = runEnds(job, home, out)[before] ?? null;
      state = status();
      blocked ||= state === "blocked"; // A permission prompt or a question in text. Nothing answers it here.
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
  return {
    verified: end?.verified ?? null,
    status: end?.status ?? null,
    attempts: end?.attempts ?? null,
    duration_ms: deps.now() - started,
    tokens: tokens(deps.claudeDir, session),
    end_reason: reason,
    blocked,
    auto_answers: jsonLines(join(home, "auto_answers.jsonl")).length,
    session_id: session,
    log: end?.log ?? null,
    ...(error ? { error } : {}),
  };
}

const paneId = (reply: string, key: "pane" | "root_pane"): string => JSON.parse(reply).result[key].pane_id;

/**
 * A new herdr tab in the workspace the batch is started from (else herdr's current one): the progress board in its
 * first pane, and one shell pane per parallel run.
 */
function openPanes(count: number, board: string[], out: string, deps: Deps) {
  const cwd = ["--cwd", process.cwd(), "--no-focus"];
  const here = process.env.HERDR_WORKSPACE_ID;
  const tab = ["tab", "create", ...(here ? ["--workspace", here] : []), "--label", `batch-${basename(out)}`, ...cwd];
  const root = paneId(deps.herdr(tab), "root_pane");
  const split = (from: string, direction: string) =>
    paneId(deps.herdr(["pane", "split", from, "--direction", direction, ...cwd]), "pane");
  const slots = [split(root, "down")];
  while (slots.length < count) slots.push(split(slots[slots.length - 1], "right"));
  deps.herdr(["pane", "run", root, board.map(quote).join(" ")]);
  const close = (pane: string) => {
    try {
      deps.herdr(["pane", "close", pane]);
    } catch {
      deps.out(`WARNING: could not close pane ${pane}`);
    }
  };
  /** Ends the session in a slot: a new shell takes its place before its pane closes, so the layout stays. */
  const renew = (slot: number) => {
    const used = slots[slot];
    try {
      slots[slot] = split(used, "down");
    } catch {
      deps.out(`WARNING: could not replace pane ${used}`);
    }
    close(used);
  };
  return { slots, renew, closeSlots: () => slots.forEach(close) };
}

function claudeVersion(deps: Deps): string | null {
  try {
    return deps.claudeVersion();
  } catch {
    return null; // The launch will record its own failure.
  }
}

/** HEAD, refused with uncommitted or untracked files: they change the conditions and the commit does not show them. */
function cleanCommit(deps: Deps): string {
  const changed = deps.git("status", "--porcelain", "--untracked-files=normal");
  if (changed) throw new Error(`Commit, stash or ignore these files first:\n${changed}`);
  return deps.git("rev-parse", "HEAD");
}

const USAGE =
  "usage: node research/batch.ts (--tasks A,B | --webarena 0,11) --model MODEL --out DIR [--repeat N] " +
  "[--parallel N] [--serial A,B] [--full]";

const split = (text: string | undefined) => (text ?? "").split(",").filter(Boolean);

function jobs(tasks: string[], webarena: string[], deps: Deps): Job[] {
  if (webarena.length === 0) {
    const unknown = tasks.filter((task) => !listTasks().includes(task));
    if (unknown.length > 0) throw new Error(`Unknown task: ${unknown.join(", ")} (run from the repository root)`);
    return tasks.map((task) => ({ task, id: null }));
  }
  const known = new Set(deps.webarenaIds().map(String));
  const unknown = webarena.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`Unknown WebArena task ID: ${unknown.join(", ")}`);
  return webarena.map((id) => ({ task: `webarena_${id}`, id: Number(id) }));
}

export async function batch(argv: string[], deps: Deps = defaults): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      tasks: { type: "string" },
      webarena: { type: "string" },
      repeat: { type: "string", default: "1" },
      parallel: { type: "string", default: "3" },
      serial: { type: "string" },
      model: { type: "string" },
      out: { type: "string" },
      full: { type: "boolean", default: false },
    },
  });
  const { model, full } = values;
  const repeat = Number(values.repeat);
  const parallel = Number(values.parallel);
  const positive = (n: number) => Number.isInteger(n) && n >= 1;
  const given = [values.tasks, values.webarena].filter(Boolean).length;
  if (given !== 1 || !model || !values.out || !positive(repeat) || !positive(parallel)) throw new Error(USAGE);
  const webarena = split(values.webarena);
  if (webarena.length > 0 && repeat !== 1) {
    throw new Error("--repeat is not for --webarena: a task's output folder holds one run. Use another --out.");
  }
  if (new Set(webarena).size !== webarena.length) throw new Error("--webarena lists a task twice");
  const listed = webarena.length > 0 ? webarena : split(values.tasks);
  const serial = new Set(split(values.serial));
  const stray = [...serial].filter((name) => !listed.includes(name));
  if (stray.length > 0) throw new Error(`--serial names a task that is not run: ${stray.join(", ")}`);
  const all = jobs(split(values.tasks), webarena, deps);
  const out = resolve(values.out);
  const results = join(out, "results.jsonl");
  if (!relative(process.cwd(), out).startsWith("..")) {
    try {
      deps.git("check-ignore", "-q", results);
    } catch {
      throw new Error("--out must be outside the repository or ignored by git");
    }
  }
  const commit = cleanCommit(deps);
  const other = jsonLines(results).find((row) => row.commit !== commit);
  if (other) throw new Error(`${results} has a run of commit ${other.commit}, not HEAD ${commit}. Use a new --out.`);
  deps.herdr(["pane", "list"]); // Stops here, with nothing recorded, when herdr is not available.
  mkdirSync(out, { recursive: true });
  const profile = full ? "full" : "lean";
  const rows: Json[] = [];
  const queued: { job: Job; key: Json }[] = [];
  const later: typeof queued = [];
  for (let n = 1; n <= repeat; n++) {
    for (const job of all) {
      const key = { task: job.task, n, profile, model };
      const row = jsonLines(results).find((one) => Object.entries(key).every(([k, v]) => one[k] === v));
      if (row) rows.push(row);
      else (serial.has(job.id === null ? job.task : String(job.id)) ? later : queued).push({ job, key });
    }
  }
  const pending = [...queued, ...later];
  if (pending.length > 0) {
    const since = new Date(deps.now()).toISOString();
    const names = pending.map(({ job }) => job.task).join(",");
    const board = ["node", "research/progress.ts", "--tasks", names, "--since", since, "--dir", out];
    const panes = openPanes(Math.min(parallel, pending.length), board, out, deps);
    let failure: unknown = null;
    /** Takes the next run until the queue is empty, or until any slot has stopped the batch. */
    const work = async (queue: typeof queued, slot: number) => {
      while (!failure && queue.length > 0) {
        const { job, key } = queue.shift() as (typeof queued)[number];
        try {
          // A new home for every run, so a log left by an interrupted run is never taken for this one.
          const home = join(out, "homes", `${job.task}-${key.n}-${randomUUID().slice(0, 8)}`);
          if (cleanCommit(deps) !== commit) throw new Error(`HEAD moved from ${commit} during the batch. Stopped.`);
          deps.out(`RUN ${job.task} #${key.n} (${profile})`);
          const versions = { claude_version: claudeVersion(deps), batch_node_version: process.version };
          const run = await runTask(job, home, panes.slots[slot], { model, full, out }, deps);
          const row = { ...key, commit, ...versions, serial: queue === later, ...run };
          appendFileSync(results, `${JSON.stringify(row)}\n`);
          const result = job.id === null ? `verified=${row.verified}` : `status=${row.status}`;
          deps.out(`  ${job.task} #${key.n} ${result} end_reason=${row.end_reason} blocked=${row.blocked}`);
          rows.push(row);
          panes.renew(slot);
        } catch (caught) {
          failure = caught;
        }
      }
    };
    await Promise.all(panes.slots.map((_, slot) => work(queued, slot)));
    await work(later, 0);
    panes.closeSlots();
    if (failure) throw failure;
  }
  if (webarena.length > 0) {
    // Scores are WebArena-Verified's, not tasks/' verify().
    deps.out(deps.webarena(["eval", "--output-dir", out, "--task-ids", webarena.join(",")]));
    deps.out(deps.webarena(["report", "--output-dir", out]));
    const ended = rows.filter((row) => row.end_reason === "run_end").length;
    deps.out(`RUNS ${ended}/${rows.length} reached run_end`);
  } else {
    const passed = rows.filter((row) => row.verified === true).length;
    deps.out(`VERIFIED ${passed}/${rows.length} (${Math.round((100 * passed) / rows.length)}%)`);
  }
  const total = (key: keyof Tokens) => rows.reduce((sum, row) => sum + (row.tokens?.[key] ?? 0), 0);
  deps.out(`TOKENS ${TOKENS.map((key) => `${key}=${total(key)}`).join(" ")}`);
  const missing = rows.filter((row) => !row.tokens).length;
  if (missing > 0) deps.out(`TOKENS missing for ${missing} run(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await batch(process.argv.slice(2));
}
