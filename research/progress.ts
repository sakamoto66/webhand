/**
 * Shows a research run's progress while it runs, from another terminal. Not shipped: run it from the research
 * repository's root as `node research/progress.ts [--dir DIR]... [--log FILE] [--once]`.
 *
 * It only reads what webhand already writes:
 *   WEBHAND_HOME/state/session[-ID].json  the open session: its task, attempt, start time, and log path (gone at finish)
 *   WEBHAND_HOME/state/session[-ID].lock  held while a webhand command (start, run, answer, ...) runs
 *   the run log (.jsonl)                    one line per event, written as it happens; run_end carries verified
 * The run log is under WEBHAND_HOME/runs/, or OUT_DIR/ID/webhand.jsonl for research/webarena.ts. With no --dir, it
 * looks in $WEBHAND_HOME, ~/.webhand, and this checkout (where WEBHAND_HOME may point, and where webarena writes).
 *
 * Not in the records, so not shown: when each event happened (only the start time is logged; times here are when
 * this script saw the line), what Claude is doing between commands, Jev's decision before it is acted on, and the
 * WebArena score (eval_result.json holds expected answers and is never read).
 *
 * Page text, typed values, the session's values, and verify()'s evidence (it may hold the expected answer) are never
 * printed: steps show the control's label, clipped and stripped of control characters, and values by their labels.
 */

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: log lines are untyped JSON.
type Event = Record<string, any>;

export interface Session {
  /** The session id: "default", or the --id it was started with. */
  id: string;
  file: string;
  log: string | null;
  task: string | null;
  attempt: number | null;
  maxAttempts: number | null;
  /** Epoch ms. */
  started: number | null;
  /** The pid in session[-ID].lock when that process is alive: a webhand command is running. */
  busy: number | null;
  webarenaDir: string | null;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "profiles", "auth"]);
const MAX_DEPTH = 5;

/** Where to look when no --dir is given. */
export function defaultRoots(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const roots = [env.WEBHAND_HOME, join(homedir(), ".webhand"), gitRoot(cwd) ?? cwd].filter(Boolean) as string[];
  const seen = new Set<string>();
  return roots.filter((root) => {
    let real: string;
    try {
      real = realpathSync(root);
    } catch {
      return false;
    }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

function gitRoot(cwd: string): string | null {
  try {
    return (
      execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}

function entries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every folder named state under the roots (a WEBHAND_HOME's), without going into it. */
function stateDirs(roots: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of entries(dir)) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.endsWith("-screenshots")) continue;
      const path = join(dir, entry.name);
      if (entry.name === "state") found.push(path);
      else if (depth < MAX_DEPTH) walk(path, depth + 1);
    }
  };
  for (const root of roots) {
    if (basename(root) === "state") found.push(root);
    else walk(root, 1);
  }
  return [...new Set(found)];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** The open sessions under the roots. Only the fields above are taken from the state, which also holds values. */
export function findSessions(roots: string[]): Session[] {
  const sessions: Session[] = [];
  for (const dir of stateDirs(roots)) {
    for (const entry of entries(dir)) {
      const match = /^session(?:-([A-Za-z0-9_-]+))?\.json$/.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const file = join(dir, entry.name);
      let state: Event;
      try {
        state = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue; // Being replaced; the next look sees it.
      }
      const id = match[1] ?? "default";
      let busy: number | null = null;
      try {
        const pid = Number.parseInt(
          readFileSync(join(dir, `${entry.name.slice(0, -".json".length)}.lock`), "utf8"),
          10,
        );
        if (Number.isInteger(pid) && alive(pid)) busy = pid;
      } catch {
        // No command is running.
      }
      const log = str(state.log);
      const started = num(state.started);
      sessions.push({
        id,
        file,
        log: log ? (isAbsolute(log) ? log : resolve(dirname(dirname(dir)), log)) : null,
        task: str(state.task) ?? (state.meta?.webarena ? `webarena_${state.meta.webarena.task_id}` : null),
        attempt: num(state.plan?.attempt),
        maxAttempts: num(state.max_attempts),
        started: started === null ? null : started * 1000,
        busy,
        webarenaDir: str(state.meta?.webarena?.task_dir),
      });
    }
  }
  return sessions.sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
}

/** The run logs under the roots (files ending in .jsonl whose first line is a run's start), newest first. */
export function findLogs(roots: string[]): string[] {
  const found: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of entries(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && entry.name !== "state" && !entry.name.endsWith("-screenshots")) {
          if (depth < MAX_DEPTH) walk(path, depth + 1);
        }
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && isRunLog(path)) {
        found.push({ path, mtime: statSync(path).mtimeMs });
      }
    }
  };
  for (const root of roots) walk(root, 1);
  return [...new Map(found.map((log) => [log.path, log])).values()]
    .sort((a, b) => b.mtime - a.mtime)
    .map((log) => log.path);
}

function isRunLog(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(200);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return /^\{"type":"(run_start|start_failed)"/.test(buffer.subarray(0, read).toString("utf8"));
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

function modified(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** The complete lines added since offset, and where the next read starts. A line being written waits. */
export function readNew(path: string, offset: number): { events: Event[]; offset: number } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { events: [], offset };
  }
  try {
    const size = statSync(path).size;
    if (size <= offset) return { events: [], offset: size < offset ? 0 : offset };
    const buffer = Buffer.alloc(size - offset);
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    const text = buffer.subarray(0, read).toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return { events: [], offset };
    const events: Event[] = [];
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Not a log line.
      }
    }
    return { events, offset: offset + Buffer.byteLength(text.slice(0, end + 1)) };
  } finally {
    closeSync(fd);
  }
}

/** Text from the log for the terminal: no control or format characters (a page can put escapes in a label). */
export function clip(value: unknown, max: number): string {
  if (value === null || value === undefined) return "";
  const text = String(value)
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

const labels = (values: unknown): string =>
  Array.isArray(values) && values.length ? ` values: ${values.map((v) => clip(v, 30)).join(", ")}` : "";

/** One line for an event, or null for the ones that only add noise (Jev calls, screenshots, page outlines). */
export function describe(event: Event): string | null {
  const a = num(event.attempt);
  const at = a === null ? "" : ` (attempt ${a})`;
  switch (event.type) {
    case "run_start":
      return [
        `start  task=${clip(event.task ?? "adhoc", 40)} max_attempts=${event.max_attempts ?? "?"}`,
        event.flow ? ` flow=${clip(event.flow, 8)}` : "",
        event.engine ? ` engine=${clip(event.engine, 20)}` : "",
        event.session ? ` session=${clip(event.session, 10)}` : "",
        event.runbook?.name ? ` runbook=${clip(event.runbook.name, 40)}` : "",
        `\n  goal: ${clip(event.goal, 160)}`,
      ].join("");
    case "start_failed":
      return `START FAILED: ${clip(event.error, 160)}`;
    case "plan": {
      const steps = Array.isArray(event.steps) ? event.steps.length : typeof event.steps === "string" ? 1 : 0;
      return `plan${at}: ${steps} step${steps === 1 ? "" : "s"}${labels(event.values)}${event.restart ? " (restart)" : ""}${event.reason ? ` — ${clip(event.reason, 100)}` : ""}`;
    }
    case "step": {
      const who = event.decided_by ? ` ${clip(event.decided_by, 10)}` : "";
      const conf = num(event.confidence) === null ? "" : ` ${event.confidence.toFixed(2)}`;
      const value = event.value
        ? ` value=${clip(event.value, 30)}`
        : num(event.text_chars)
          ? ` (${event.text_chars} chars)`
          : "";
      return `step ${event.step}${at}: ${clip(event.operation, 12)} "${clip(event.action, 60)}"${value} [${who.trim()}${conf}]`;
    }
    case "step_result":
      return event.page_changed === false ? `       step ${event.step}: the page did not change` : null;
    case "escalation":
      return `STOP${at}: ${clip(event.reason, 20)}${event.detail ? ` — ${clip(event.detail, 120)}` : ""}`;
    case "attempt_end":
      return `attempt ${a ?? "?"} ended: ${clip(event.outcome, 20)}${event.reason ? ` — ${clip(event.reason, 120)}` : ""}`;
    case "answer":
      return `answer${at} after ${clip(event.after, 20) || "?"}${labels(event.values)}`;
    case "values":
      return `values added${at}:${labels(event.labels).replace(" values:", "")}`;
    case "human_step":
      return `person${at}: ${event.status === "done" ? "done" : "asked to act in the window"}`;
    case "not_visible":
      return `not visible${at}: Jev wanted ${clip(event.wanted, 60)}`;
    case "stale":
      return `stale${at}: ${clip(event.wanted, 12)} "${clip(event.target, 60)}" was refused`;
    case "run_end": {
      const parts = [
        `END    status=${clip(event.status, 12)} verified=${event.verified === true ? "true" : event.verified === false ? "false" : "-"}`,
        ` attempts=${event.attempts ?? "?"} actions=${event.actions ?? "?"} decisions=${event.decisions ?? "?"}`,
        num(event.elapsed_ms) === null ? "" : ` elapsed=${duration(event.elapsed_ms)}`,
        num(event.har_entries) === null ? "" : ` har_entries=${event.har_entries}`,
      ];
      // Not the evidence: verify() may put the expected answer there, and finish does not print it either.
      return parts.join("");
    }
    case "call":
    case "screenshot":
    case "page":
    case "page_check":
    case "handoff":
      return null;
    default:
      return typeof event.type === "string" ? `${clip(event.type, 30)}${at}` : null;
  }
}

/** What the run is doing now, from the last event and whether a command is running. */
export function phase(last: Event | null, busy: boolean): string {
  if (!last) return busy ? "starting" : "no event yet";
  if (last.type === "run_end" || last.type === "start_failed") return "finished";
  if (busy) {
    if (last.type === "step" || last.type === "step_result" || last.type === "not_visible" || last.type === "stale")
      return "Jev is acting (a webhand command is running)";
    return "a webhand command is running";
  }
  if (last.type === "escalation")
    return `attempt stopped with ${clip(last.reason, 20)}; Claude decides (answer, replan, or finish)`;
  return "waiting for Claude (no webhand command running)";
}

export interface IO {
  out(text: string): void;
}

export interface Deps {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realDeps: Deps = { now: () => Date.now(), sleep: (ms) => new Promise((done) => setTimeout(done, ms)) };

interface Followed {
  log: string;
  label: string;
  offset: number;
  last: Event | null;
  started: number | null;
  lastSeen: number;
  nextIdle: number;
  done: boolean;
  webarenaDir: string | null;
  webarenaFiles: Set<string>;
  doneAt: number | null;
}

const USAGE = `usage: node research/progress.ts [--dir DIR]... [--log FILE] [--once]

Shows a webhand research run's progress (/webhand-research, /webhand-webarena-research) as it runs.

  --dir DIR   where to look for sessions and logs: a WEBHAND_HOME, a webarena --out-dir, or a batch --out
              (repeatable). Default: $WEBHAND_HOME, ~/.webhand, and this checkout
  --log FILE  follow this run log until it ends
  --once      print what is known now and exit
`;

const IDLE_MS = 60_000;
const POLL_MS = 500;
const DISCOVER_MS = 2_000;
const WEBARENA_WAIT_MS = 15_000;

/** Runs the watcher. Returns when --once has printed, or when the --log run has ended. Watches until killed otherwise. */
export async function progress(argv: string[], io: IO, deps: Deps = realDeps): Promise<number> {
  const dirs: string[] = [];
  let logArg: string | null = null;
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      io.out(USAGE);
      return 0;
    }
    if (arg === "--once") once = true;
    else if (arg === "--dir" && argv[i + 1]) dirs.push(resolve(argv[++i]));
    else if (arg === "--log" && argv[i + 1]) logArg = resolve(argv[++i]);
    else {
      io.out(`unrecognized argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }
  const roots = dirs.length ? dirs : defaultRoots();
  const followed = new Map<string, Followed>();
  let sessions: Session[] = [];

  const follow = (log: string, label: string, started: number | null, webarenaDir: string | null) => {
    const entry: Followed = {
      log,
      label,
      offset: 0,
      last: null,
      started,
      lastSeen: modified(log) ?? deps.now(),
      nextIdle: deps.now() + IDLE_MS,
      done: false,
      webarenaDir,
      webarenaFiles: new Set(),
      doneAt: null,
    };
    followed.set(log, entry);
    io.out(`── ${label}  log: ${log}\n`);
    return entry;
  };

  const prefix = (entry: Followed, live: boolean) => {
    const tag = followed.size > 1 || sessions.length > 1 ? `[${entry.label}] ` : "";
    if (!live || entry.started === null) return `${tag}        `;
    return `${tag}+${duration(deps.now() - entry.started).padStart(6)} `;
  };

  /** Prints the new lines of a log. The first read is the run so far, shown without times. */
  const drain = (entry: Followed, live: boolean) => {
    const { events, offset } = readNew(entry.log, entry.offset);
    entry.offset = offset;
    for (const event of events) {
      if (event.type === "run_start" && typeof event.started_at === "string") {
        const at = Date.parse(event.started_at);
        if (Number.isFinite(at)) entry.started = at;
      }
      entry.last = event;
      const line = describe(event);
      if (line) {
        const [first, ...more] = line.split("\n");
        io.out(`${prefix(entry, live)}${first}\n${more.map((text) => `${prefix(entry, false)}${text}\n`).join("")}`);
      }
      if (event.type === "run_end" || event.type === "start_failed") {
        entry.done = true;
        entry.doneAt = deps.now();
      }
    }
    if (events.length && live) {
      entry.lastSeen = deps.now();
      entry.nextIdle = entry.lastSeen + IDLE_MS;
    }
    return events.length;
  };

  const sessionFor = (entry: Followed) => sessions.find((s) => s.log === entry.log) ?? null;

  const statusLine = (entry: Followed) => {
    const s = sessionFor(entry);
    const attempt = s?.attempt ? ` attempt ${s.attempt}/${s.maxAttempts ?? "?"}` : "";
    const elapsed = entry.started === null ? "" : ` elapsed ${duration(deps.now() - entry.started)}`;
    const quiet = entry.done ? "" : `, last event seen ${duration(deps.now() - entry.lastSeen)} ago`;
    return `${prefix(entry, false)}now:${attempt}${elapsed} — ${phase(entry.last, Boolean(s?.busy))}${quiet}\n`;
  };

  /** research/webarena.ts writes agent_response.json after run_end; eval writes eval_result.json. Names only. */
  const webarenaFiles = (entry: Followed) => {
    if (!entry.webarenaDir) return;
    for (const name of ["agent_response.json", "eval_result.json"]) {
      if (entry.webarenaFiles.has(name) || !existsSync(join(entry.webarenaDir, name))) continue;
      entry.webarenaFiles.add(name);
      io.out(`${prefix(entry, true)}wrote ${join(entry.webarenaDir, name)}\n`);
    }
  };

  const discover = () => {
    sessions = findSessions(roots);
    for (const s of sessions) {
      if (!s.log || followed.has(s.log)) continue;
      const label = `${s.task ?? "adhoc"}${s.id === "default" ? "" : ` --id ${s.id}`}`;
      const entry = follow(s.log, label, s.started, s.webarenaDir);
      drain(entry, false);
      if (!entry.done) io.out(statusLine(entry));
    }
  };

  if (logArg) {
    const entry = follow(logArg, basename(logArg, ".jsonl"), null, null);
    sessions = findSessions(roots);
    entry.webarenaDir =
      sessionFor(entry)?.webarenaDir ?? (basename(logArg) === "webhand.jsonl" ? dirname(logArg) : null);
    drain(entry, false);
    if (entry.done) return 0;
    io.out(statusLine(entry));
    if (once) return 0;
  } else {
    discover();
    if (!followed.size) {
      const last = findLogs(roots)[0];
      io.out(`No open session under: ${roots.join(", ")}\n`);
      if (last) {
        const { events } = readNew(last, 0);
        const end = [...events].reverse().find((e) => e.type === "run_end" || e.type === "start_failed");
        io.out(
          `Last run log: ${last}\n${end ? `        ${describe(end)}\n` : "        (no run_end: the run did not finish)\n"}`,
        );
      }
      if (once) return 0;
      io.out("Waiting for a run to start (Ctrl-C to quit)\n");
    } else if (once) {
      return 0;
    }
  }

  let nextDiscover = deps.now() + DISCOVER_MS;
  while (true) {
    await deps.sleep(POLL_MS);
    if (!logArg && deps.now() >= nextDiscover) {
      discover();
      nextDiscover = deps.now() + DISCOVER_MS;
    } else if (logArg) {
      sessions = findSessions(roots);
    }
    for (const entry of [...followed.values()]) {
      drain(entry, true);
      webarenaFiles(entry);
      if (!entry.done && deps.now() >= entry.nextIdle) {
        io.out(statusLine(entry));
        entry.nextIdle = deps.now() + IDLE_MS;
      }
      // A webarena finish writes agent_response.json after run_end, and eval_result.json with --eval: wait a little.
      const waited = entry.doneAt !== null && deps.now() - entry.doneAt >= WEBARENA_WAIT_MS;
      if (entry.done && (!entry.webarenaDir || waited || entry.webarenaFiles.has("eval_result.json"))) {
        if (logArg) return 0;
        if (!sessions.some((s) => s.log === entry.log)) {
          followed.delete(entry.log);
          if (!followed.size) io.out("Waiting for the next run (Ctrl-C to quit)\n");
        }
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await progress(process.argv.slice(2), { out: (text) => process.stdout.write(text) });
}
