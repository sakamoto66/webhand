/** The event view of research/progress.ts: one line per log event, with times as this script saw them. */

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  describe,
  duration,
  type Event,
  findLogs,
  findSessions,
  modified,
  phase,
  readNew,
  runName,
  type Session,
} from "./records.ts";

export interface IO {
  out(text: string): void;
  /** Whether out() writes to a terminal (the board then redraws in place). */
  tty?: boolean;
}

export interface Deps {
  now(): number;
  sleep(ms: number): Promise<void>;
}

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

const IDLE_MS = 60_000;
const POLL_MS = 500;
const DISCOVER_MS = 2_000;
const WEBARENA_WAIT_MS = 15_000;

/**
 * One line per event, as the events happen (--events, or --log FILE for one log). Returns when --once has printed, or
 * when the --log run has ended. Watches until killed otherwise.
 */
export async function events(
  roots: string[],
  logArg: string | null,
  once: boolean,
  io: IO,
  deps: Deps,
): Promise<number> {
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
  const webarenaFiles = (entry: Followed, live: boolean) => {
    if (!entry.webarenaDir) return;
    for (const name of ["agent_response.json", "eval_result.json"]) {
      if (entry.webarenaFiles.has(name) || !existsSync(join(entry.webarenaDir, name))) continue;
      entry.webarenaFiles.add(name);
      io.out(`${prefix(entry, live)}wrote ${join(entry.webarenaDir, name)}\n`);
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
    const entry = follow(logArg, runName(logArg) ?? basename(logArg, ".jsonl"), null, null);
    sessions = findSessions(roots);
    entry.webarenaDir =
      sessionFor(entry)?.webarenaDir ?? (basename(logArg) === "webhand.jsonl" ? dirname(logArg) : null);
    drain(entry, false);
    if (entry.done) {
      webarenaFiles(entry, false); // Already written when the run ended before this started.
      return 0;
    }
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
      webarenaFiles(entry, true);
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
