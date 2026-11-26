/**
 * Shows research runs' progress while they run, from another terminal. Not shipped: run it from the research
 * repository as `node research/progress.ts [options]` (see USAGE).
 *
 * It only reads what webhand already writes:
 *   WEBHAND_HOME/state/session[-ID].json  an open session: its task, attempt, start time, log path, browser pid
 *   WEBHAND_HOME/state/session[-ID].lock  held while a webhand command (start, run, answer, ...) runs
 *   the run log (.jsonl)                    one line per event, written as it happens; run_end carries verified
 *   OUT_DIR/ID/eval_result.json             for WebArena, its top-level score and status only
 * The run log is under WEBHAND_HOME/runs/, or OUT_DIR/ID/webhand.jsonl for research/webarena.ts. With no --dir, it
 * looks in $WEBHAND_HOME, ~/.webhand, and this checkout (where WEBHAND_HOME may point, and where webarena writes).
 *
 * Not in the records, so not shown: when each event happened (only the start is logged; quiet times come from the
 * log's modification time), what Claude is doing between commands, Jev's decision before it is acted on, and how many
 * runs are planned (give --tasks or a count).
 *
 * Page text, typed values, the session's values, verify()'s evidence (it may hold the expected answer), and the rest
 * of eval_result.json are never printed: steps show the control's label, clipped and stripped of control characters,
 * and values by their labels.
 */

import { resolve } from "node:path";
import { collect, type Options, type Plan, parseTaskList, render } from "./progress/board.ts";
import { type Deps, events, type IO } from "./progress/events.ts";
import { defaultRoots, findSessions } from "./progress/records.ts";

const USAGE = `usage: node research/progress.ts [--tasks LIST | --research N --webarena N | --total N] [--since WHEN]
                                 [--stall MIN] [--dir DIR]... [--once] [--events | --log FILE]

Shows the progress of /webhand-research and /webhand-webarena-research runs, from another terminal. The board
(default) counts runs per skill against the plan, lists the open runs and whether they move, and redraws every second.

  --tasks LIST    the planned runs: task names and WebArena IDs, comma-separated (a name twice is two runs),
                  e.g. --tasks hotel_filter,qty_stepper,94,157
  --research N    planned /webhand-research runs (any task); with --webarena N for WebArena runs
  --total N       planned runs of either skill
                  With no plan, the board shows no totals, not started, or ETA.
  --since WHEN    count runs started since WHEN: 30m, 2h, 14:05, or an ISO time. Default: when this started
                  (runs whose session is already open are counted too)
  --stall MIN     an open run with no new event for MIN minutes is shown as stalled (default 5)
  --dir DIR       where to look: a WEBHAND_HOME or a webarena --out-dir (repeatable).
                  Default: $WEBHAND_HOME, ~/.webhand, and this checkout
  --once          print once and exit
  --events        one line per event instead of the board
  --log FILE      the events of this run log, until it ends
`;

const realDeps: Deps = { now: () => Date.now(), sleep: (ms) => new Promise((done) => setTimeout(done, ms)) };

/** 30m, 2h, 14:05 (today, or yesterday when that is still to come), or an ISO time. null when it is none of them. */
export function parseSince(text: string, now: number): number | null {
  const relative = /^(\d+)(m|h)$/.exec(text);
  if (relative) return now - Number(relative[1]) * (relative[2] === "h" ? 3_600_000 : 60_000);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const at = new Date(now);
    at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    return at.getTime() > now ? at.getTime() - 86_400_000 : at.getTime();
  }
  const iso = Date.parse(text);
  return Number.isFinite(iso) ? iso : null;
}

const count = (text: string | undefined) => (text && /^\d+$/.test(text) ? Number(text) : null);

export async function progress(argv: string[], io: IO, deps: Deps = realDeps): Promise<number> {
  const dirs: string[] = [];
  let logArg: string | null = null;
  let once = false;
  let eventsView = false;
  let tasks: string[] | null = null;
  const counts = { research: 0, webarena: 0, any: 0 };
  const given: string[] = [];
  let since: number | null = null;
  let stallMs = 5 * 60_000;
  const fail = (message: string) => {
    io.out(`${message}\n${USAGE}`);
    return 2;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      io.out(USAGE);
      return 0;
    }
    if (arg === "--once") once = true;
    else if (arg === "--events") eventsView = true;
    else if (arg === "--dir" && value) dirs.push(resolve(argv[++i]));
    else if (arg === "--log" && value) logArg = resolve(argv[++i]);
    else if (arg === "--tasks" && value) {
      tasks = parseTaskList(argv[++i]);
      if (!tasks.length) return fail("--tasks needs task names or WebArena IDs");
      given.push(`--tasks ${tasks.length}`);
    } else if ((arg === "--research" || arg === "--webarena" || arg === "--total") && count(value) !== null) {
      const n = count(argv[++i]) as number;
      counts[arg === "--total" ? "any" : (arg.slice(2) as "research" | "webarena")] = n;
      given.push(`${arg} ${n}`);
    } else if (arg === "--since" && value) {
      since = parseSince(argv[++i], deps.now());
      if (since === null) return fail(`--since: expected 30m, 2h, 14:05, or an ISO time, got ${argv[i]}`);
    } else if (arg === "--stall" && count(value)) stallMs = (count(argv[++i]) as number) * 60_000;
    else return fail(`unrecognized argument: ${arg}`);
  }
  if (tasks && (counts.research || counts.webarena || counts.any)) {
    return fail("give either --tasks or counts (--research, --webarena, --total), not both");
  }
  const roots = dirs.length ? dirs : defaultRoots();
  if (logArg || eventsView) return events(roots, logArg, once, io, deps);

  const started = deps.now();
  const plan: Plan | null =
    tasks || counts.research || counts.webarena || counts.any ? { tasks, counts, source: given.join(" ") } : null;
  const options: Options = {
    roots,
    plan,
    origin: since ?? started,
    originSource: since === null ? "when this started; --since to change" : "--since",
    stallMs,
  };
  // Runs already open when the board starts are part of what it watches, whenever they started.
  const openAtOrigin = new Set(
    since === null ? findSessions(roots).flatMap((s) => (s.log ? [s.log] : [])) : ([] as string[]),
  );
  const logs = new Map();
  let shown = "";
  while (true) {
    const now = deps.now();
    const board = collect(options, logs, now, openAtOrigin);
    if (io.tty && !once) {
      io.out(`\x1b[H\x1b[2J${render(board, options, now)}(Ctrl-C to quit)\n`);
    } else {
      // Not a terminal: a new snapshot only when something other than the clock changed.
      const stable = render(board, options, now, true);
      if (stable !== shown) io.out(`${render(board, options, now)}\n`);
      shown = stable;
    }
    if (once) return 0;
    await deps.sleep(1000);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await progress(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    tty: process.stdout.isTTY,
  });
}
