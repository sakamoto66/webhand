/**
 * The board: every run counted since a start time, per skill (webhand-research and webhand-webarena-research), against
 * a plan the person gives (a task list or counts), with the open runs and whether they move. Redrawn in a terminal.
 *
 * Counting rules:
 *   - A run counts when its run_start is at or after the origin (--since, else when the board started), or when its
 *     session was already open at that time. Older runs are not counted.
 *   - The plan has slots: one per listed task (a name listed twice is two slots), or N per skill or overall. A slot is
 *     taken by the earliest counted run of that task (any task for a count), finished or not, failed or not. Later runs
 *     of the same task are re-runs: they are counted in the results but take no slot, so done never exceeds the plan.
 *     Runs of tasks not in a list are counted in the results and shown as not in the plan.
 *   - Result: research tasks by run_end's verified only (status=done is not success). WebArena runs by the score in
 *     eval_result.json (score and status only; the rest holds expected answers and is not read), else unscored.
 *   - A run with no run_end, no open session, and no write for a while is interrupted. It counts as done, not OK.
 *   - An open run is stalled when its log has not changed for --stall minutes (default 5), or its browser is gone.
 *     A run whose webhand command still runs is shown as stalled too, but as a command that runs without events.
 *   - ETA needs a plan and one done slot: remaining slots × (time since the first counted run started ÷ done slots),
 *     so the time Claude spends between runs and running several at once are both in the rate.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  alive,
  clip,
  describe,
  duration,
  type Event,
  findLogs,
  findSessions,
  modified,
  readNew,
  type Session,
} from "./records.ts";

type Skill = "research" | "webarena";

export interface Plan {
  /** Task names (webarena_ID for WebArena), one per slot, in the order given. */
  tasks: string[] | null;
  /** Slot counts per skill, and for any skill. */
  counts: { research: number; webarena: number; any: number };
  /** How it was given, for the header. */
  source: string;
}

export interface Options {
  roots: string[];
  plan: Plan | null;
  /** Epoch ms: runs that started before it are not counted, unless their session was open then. */
  origin: number;
  originSource: string;
  stallMs: number;
}

/** What a log has said so far; read again only from where it stopped. */
interface LogState {
  path: string;
  offset: number;
  task: string | null;
  started: number | null;
  end: Event | null;
  last: Event | null;
  lastMtime: number | null;
}

interface Run {
  log: string;
  task: string;
  skill: Skill;
  label: string;
  started: number;
  state: "running" | "done" | "interrupted";
  ended: number | null;
  /** ok and ng for research tasks; score_ok, score_ng, unscored for WebArena; no_verify for a run without verify(). */
  result: "ok" | "ng" | "score_ok" | "score_ng" | "unscored" | "no_verify" | null;
  kind: string | null;
  attempts: number | null;
  session: Session | null;
  last: Event | null;
  quietMs: number;
  /** Set when the run takes a plan slot. */
  slot: boolean;
  /** Not in the task list, or a later run of a task that already has its slots. */
  extra: "not_in_plan" | "rerun" | null;
}

const INTERRUPTED_QUIET_MS = 30_000;

function skillOf(task: string): Skill {
  return task.startsWith("webarena_") ? "webarena" : "research";
}

/** `hotel_filter,94,webarena_95` → task names; a WebArena ID becomes webarena_ID. */
export function parseTaskList(text: string): string[] {
  return text
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => (/^\d+$/.test(name) ? `webarena_${name}` : name));
}

/** Only the top-level score and status. The file also holds the expected answers; nothing else is kept or shown. */
function scoreOf(taskDir: string): { score: number | null; status: string | null } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(taskDir, "eval_result.json"), "utf8")) as Record<string, unknown>;
    return {
      score: typeof parsed.score === "number" ? parsed.score : null,
      status: typeof parsed.status === "string" ? parsed.status : null,
    };
  } catch {
    return null;
  }
}

function lastOutcome(end: Event): string | null {
  const outcomes = Array.isArray(end.attempt_outcomes) ? end.attempt_outcomes : [];
  const last = outcomes[outcomes.length - 1];
  return last && typeof last.outcome === "string" ? last.outcome : null;
}

/** The result of a finished run, and its kind when it is not OK. */
function judge(run: Run, end: Event | null): Pick<Run, "result" | "kind"> {
  if (run.state === "interrupted")
    return { result: run.skill === "webarena" ? "unscored" : "ng", kind: "interrupted (no run_end)" };
  if (!end) return { result: null, kind: null };
  if (end.type === "start_failed")
    return { result: run.skill === "webarena" ? "unscored" : "ng", kind: "start_failed" };
  const why = `${clip(end.status ?? "?", 12)}/${clip(lastOutcome(end) ?? "?", 20)}`;
  if (run.skill === "webarena") {
    const score = scoreOf(dirname(run.log));
    if (!score || (score.score === null && score.status === null))
      return { result: "unscored", kind: `${why} unscored` };
    const ok = score.status === "success" || (score.status === null && score.score === 1);
    return ok ? { result: "score_ok", kind: null } : { result: "score_ng", kind: `${why} score ${score.score ?? "?"}` };
  }
  if (end.verified === true) return { result: "ok", kind: null };
  if (end.verified === false) return { result: "ng", kind: end.status === "done" ? `${why} (verify NG)` : why };
  return { result: "no_verify", kind: `${why} no verify()` };
}

export interface Board {
  runs: Run[];
  slots: { skill: Skill | "any"; task: string | null; run: Run | null }[];
}

/** Reads the records and counts. `logs` keeps what was read between calls. */
export function collect(options: Options, logs: Map<string, LogState>, now: number, openAtOrigin: Set<string>): Board {
  const sessions = findSessions(options.roots);
  const byLog = new Map(sessions.filter((s) => s.log).map((s) => [s.log as string, s]));
  const paths = new Set([...findLogs(options.roots, options.origin), ...byLog.keys()]);
  const runs: Run[] = [];
  for (const path of paths) {
    let state = logs.get(path);
    if (!state) {
      state = { path, offset: 0, task: null, started: null, end: null, last: null, lastMtime: null };
      logs.set(path, state);
    }
    const { events, offset } = readNew(path, state.offset);
    state.offset = offset;
    for (const event of events) {
      if (event.type === "run_start") {
        state.task = typeof event.task === "string" && event.task ? event.task : "adhoc";
        const at = Date.parse(event.started_at);
        state.started = Number.isFinite(at) ? at : null;
      }
      if (event.type === "run_end" || event.type === "start_failed") {
        state.end = event;
        if (state.started === null && typeof event.started_at === "string")
          state.started = Date.parse(event.started_at);
      }
      if (describe(event) !== null) state.last = event;
    }
    state.lastMtime = modified(path);
    const session = byLog.get(path) ?? null;
    if (state.started === null) state.started = session?.started ?? null;
    if (state.started === null) continue; // Not written yet.
    if (state.started < options.origin && !openAtOrigin.has(path)) continue;
    const task = state.task ?? session?.task ?? basename(path, ".jsonl");
    const quietMs = state.lastMtime === null ? 0 : Math.max(0, now - state.lastMtime);
    const running = !state.end && (session !== null || quietMs < INTERRUPTED_QUIET_MS);
    const run: Run = {
      log: path,
      task,
      skill: skillOf(task),
      label: `${clip(task, 40)}${session && session.id !== "default" ? ` --id ${session.id}` : ""}`,
      started: state.started,
      state: state.end ? "done" : running ? "running" : "interrupted",
      ended:
        state.end && typeof state.end.elapsed_ms === "number"
          ? state.started + state.end.elapsed_ms
          : state.end || !running
            ? state.lastMtime
            : null,
      result: null,
      kind: null,
      attempts: state.end && typeof state.end.attempts === "number" ? state.end.attempts : (session?.attempt ?? null),
      session,
      last: state.last,
      quietMs,
      slot: false,
      extra: null,
    };
    Object.assign(run, judge(run, state.end));
    runs.push(run);
  }
  runs.sort((a, b) => a.started - b.started);
  return { runs, slots: assign(options.plan, runs) };
}

/** Gives each plan slot its earliest run, in start order. */
function assign(plan: Plan | null, runs: Run[]): Board["slots"] {
  if (!plan) return [];
  const slots: Board["slots"] = plan.tasks
    ? plan.tasks.map((task) => ({ skill: skillOf(task), task, run: null }))
    : [
        ...Array.from({ length: plan.counts.research }, () => ({ skill: "research" as const, task: null, run: null })),
        ...Array.from({ length: plan.counts.webarena }, () => ({ skill: "webarena" as const, task: null, run: null })),
        ...Array.from({ length: plan.counts.any }, () => ({ skill: "any" as const, task: null, run: null })),
      ];
  for (const run of runs) {
    const slot =
      slots.find((s) => !s.run && s.task !== null && s.task === run.task) ??
      slots.find((s) => !s.run && s.task === null && s.skill === run.skill) ??
      slots.find((s) => !s.run && s.task === null && s.skill === "any");
    if (slot) {
      slot.run = run;
      run.slot = true;
    } else {
      run.extra = plan.tasks && !plan.tasks.includes(run.task) ? "not_in_plan" : "rerun";
    }
  }
  return slots;
}

/** What an open run is doing, and whether that looks stuck. */
function liveness(run: Run, stallMs: number): string {
  const busy = run.session?.busy ?? null;
  const browser = run.session?.browserPid ?? null;
  if (browser !== null && !alive(browser)) return "STALLED? the browser is gone";
  if (run.quietMs >= stallMs) {
    return busy
      ? `STALLED? a webhand command runs (pid ${busy}) but no event for ${duration(run.quietMs)}`
      : `STALLED? no event for ${duration(run.quietMs)} and no webhand command running`;
  }
  if (busy) return "moving: a webhand command runs";
  if (run.last?.type === "escalation")
    return `Claude's turn after ${clip(run.last.reason, 20)} (${duration(run.quietMs)})`;
  return `Claude's turn (${duration(run.quietMs)} since the last event)`;
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

function resultText(run: Run): string {
  switch (run.result) {
    case "ok":
      return "OK";
    case "score_ok":
      return "score OK";
    case "ng":
      return `NG ${run.kind ?? ""}`.trim();
    case "score_ng":
      return `score NG ${run.kind ?? ""}`.trim();
    case "unscored":
      return `unscored ${run.kind ?? ""}`.trim();
    case "no_verify":
      return `no verify() ${run.kind ?? ""}`.trim();
    default:
      return "";
  }
}

const SKILL_NAME: Record<Skill, string> = { research: "webhand-research", webarena: "webarena-research" };

/** The board as text. `stable` leaves out the times that change every second, to tell when anything else changed. */
export function render(board: Board, options: Options, now: number, stable = false): string {
  const { runs, slots } = board;
  const lines: string[] = [];
  const time = (text: string) => (stable ? "" : text);
  lines.push(
    `webhand research progress${time(`  ${clock(now)}`)}  —  runs since ${clock(options.origin)} (${options.originSource})`,
  );

  const planned = slots.length;
  const done = slots.filter((s) => s.run && s.run.state !== "running").length;
  const running = runs.filter((r) => r.state === "running").length;
  if (options.plan) {
    let eta = "ETA: after the first planned run is done";
    const counted = slots.filter((s) => s.run).map((s) => s.run as Run);
    if (done >= planned) eta = "all planned runs are done";
    else if (done > 0) {
      const first = Math.min(...counted.map((r) => r.started));
      const per = (now - first) / done;
      eta = `ETA ${clock(now + (planned - done) * per)} (in ~${duration((planned - done) * per)}; ${duration(per)} per run from ${done} done)`;
    }
    lines.push(
      `Plan ${planned} (${options.plan.source}): done ${done}, running ${slots.filter((s) => s.run?.state === "running").length}, not started ${planned - done - slots.filter((s) => s.run?.state === "running").length}${time(`   ${eta}`)}`,
    );
  } else {
    lines.push(`Plan: unknown (give --tasks or --research/--webarena/--total for totals and ETA). Running ${running}`);
  }

  for (const skill of ["research", "webarena"] as const) {
    const mine = runs.filter((r) => r.skill === skill);
    const mySlots = slots.filter((s) => s.skill === skill || (s.skill === "any" && s.run?.skill === skill));
    if (!mine.length && !mySlots.length) continue;
    const count = (result: Run["result"]) => mine.filter((r) => r.result === result).length;
    const plan = options.plan
      ? `plan ${slots.filter((s) => s.skill === skill).length || "-"}, done ${mySlots.filter((s) => s.run && s.run.state !== "running").length}, not started ${slots.filter((s) => s.skill === skill && !s.run).length}`
      : `runs ${mine.length}`;
    const results =
      skill === "research"
        ? `verify(): OK ${count("ok")}, NG ${count("ng")}${count("no_verify") ? `, no verify() ${count("no_verify")}` : ""}`
        : `score: OK ${count("score_ok")}, NG ${count("score_ng")}, unscored ${count("unscored")}`;
    const extra = mine.filter((r) => r.extra).length;
    lines.push(
      `  ${SKILL_NAME[skill].padEnd(18)} ${plan}, running ${mine.filter((r) => r.state === "running").length}   ${results}${extra ? `   (${extra} not taking a plan slot)` : ""}`,
    );
  }
  if (options.plan && slots.some((s) => s.skill === "any")) {
    const any = slots.filter((s) => s.skill === "any");
    lines.push(`  ${"either skill".padEnd(18)} plan ${any.length}, not started ${any.filter((s) => !s.run).length}`);
  }

  const kinds = new Map<string, number>();
  for (const run of runs) if (run.state !== "running" && run.kind) kinds.set(run.kind, (kinds.get(run.kind) ?? 0) + 1);
  if (kinds.size) {
    lines.push(
      `Not OK or unscored, by kind: ${[...kinds]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, n]) => `${kind} ${n}`)
        .join(" · ")}`,
    );
  }
  const waiting = slots.filter((s) => !s.run && s.task).map((s) => s.task as string);
  if (waiting.length) lines.push(`Not started: ${waiting.join(", ")}`);

  const open = runs.filter((r) => r.state === "running");
  lines.push("", `Running (${open.length})`);
  if (!open.length) lines.push("  none");
  for (const run of open) {
    const attempt = run.session?.attempt ? `attempt ${run.session.attempt}/${run.session.maxAttempts ?? "?"}` : "";
    const last = run.last ? clip(describe(run.last)?.split("\n")[0], 70) : "no event yet";
    lines.push(
      `  ${run.label.padEnd(24)} ${attempt.padEnd(12)} ${time(duration(now - run.started).padStart(7))}  ${stable ? liveness(run, options.stallMs).replace(/\d+(h\d+m|m\d+s|s)/g, "") : liveness(run, options.stallMs)}`,
      `  ${"".padEnd(24)} last: ${last}`,
    );
  }

  const finished = runs
    .filter((r) => r.state !== "running")
    .sort((a, b) => (b.ended ?? b.started) - (a.ended ?? a.started));
  lines.push("", `Finished (${finished.length}, latest first${finished.length > 10 ? ", 10 shown" : ""})`);
  if (!finished.length) lines.push("  none");
  for (const run of finished.slice(0, 10)) {
    const took = run.ended ? duration(run.ended - run.started) : "?";
    const attempts = run.attempts === null ? "" : `${run.attempts} attempt${run.attempts === 1 ? "" : "s"}`;
    const extra = run.extra === "rerun" ? "  (re-run)" : run.extra === "not_in_plan" ? "  (not in plan)" : "";
    const state = run.state === "interrupted" ? `INTERRUPTED ${resultText(run)}` : resultText(run);
    lines.push(
      `  ${run.ended ? clock(run.ended) : "--:--:--"}  ${run.label.padEnd(24)} ${state.padEnd(40)} ${attempts.padEnd(10)} ${took}${extra}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
