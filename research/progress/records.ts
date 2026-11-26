/**
 * What research/progress.ts reads: open sessions (WEBHAND_HOME/state/session[-ID].json and its lock), run logs, and
 * how one log event reads in a terminal. Read-only. See research/progress.ts for what is and is not shown.
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: log lines are untyped JSON.
export type Event = Record<string, any>;

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
  /** The browser's pid from the state, when it has one (a local Chrome or engine daemon). */
  browserPid: number | null;
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

export function alive(pid: number): boolean {
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
        browserPid: num(state.pid),
      });
    }
  }
  return sessions.sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
}

/**
 * The run logs under the roots (files ending in .jsonl whose first line is a run's start), newest first. With since,
 * only the logs written to at or after it (epoch ms).
 */
export function findLogs(roots: string[], since = 0): string[] {
  const found: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of entries(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && entry.name !== "state" && !entry.name.endsWith("-screenshots")) {
          if (depth < MAX_DEPTH) walk(path, depth + 1);
        }
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const mtime = modified(path);
        if (mtime !== null && mtime >= since && isRunLog(path)) found.push({ path, mtime });
      }
    }
  };
  for (const root of roots) walk(root, 1);
  return [...new Map(found.map((log) => [log.path, log])).values()]
    .sort((a, b) => b.mtime - a.mtime)
    .map((log) => log.path);
}

function head(path: string, bytes: number): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)).toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

function isRunLog(path: string): boolean {
  return /^\{\s*"type"\s*:\s*"(run_start|start_failed)"/.test(head(path, 200));
}

/** The task in a log's run_start (webarena_ID for research/webarena.ts), to name the run. */
export function runName(path: string): string | null {
  const text = head(path, 64 * 1024);
  const end = text.indexOf("\n");
  try {
    const first = JSON.parse(end < 0 ? text : text.slice(0, end));
    return first.type === "run_start" && typeof first.task === "string" && first.task ? clip(first.task, 40) : null;
  } catch {
    return null;
  }
}

export function modified(path: string): number | null {
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
    case "tactical_recovery":
      return `recovery${at}: ${clip(event.strategy, 30)}`;
    case "self_verify":
      return `self-check${at}: met ${event.met ?? "?"}, unmet ${event.unmet ?? "?"}, unknown ${event.unknown ?? "?"}`;
    case "read_only_refused":
      return `read-only refused${at}: ${clip(event.kind, 12)} "${clip(event.target, 60)}"`;
    case "compare_end":
    case "collect_end":
      return `${event.type.slice(0, -"_end".length)} done${at}`;
    case "compare_failed":
    case "collect_failed":
      return `${event.type.slice(0, -"_failed".length)} FAILED${at}: ${clip(event.error, 120)}${event.uncertain ? " (uncertain)" : ""}`;
    case "drilldown_end":
      return `drilldown done${at}: seen ${event.seen ?? "?"}, matched ${event.matched ?? "?"}, visited ${event.visited ?? "?"}${event.truncated ? " (truncated)" : ""}`;
    case "check": {
      const verdicts = Array.isArray(event.results) ? event.results.map((r: Event) => clip(r?.verdict, 14)) : [];
      const counts = [...new Set(verdicts)].map((v) => `${v} ${verdicts.filter((x: string) => x === v).length}`);
      return `check: ${counts.join(", ") || "no results"}`;
    }
    case "extract":
      return `extract: ${clip(event.kind, 20)} ${event.count ?? "?"} item(s)`;
    default:
      // Everything else is internal: Jev calls, page outlines and checks, screenshots, handoffs, scan rounds,
      // known_offered, into_view, more, findings, ignored windows, drilldown details, record and check_run lines.
      return null;
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
