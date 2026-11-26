/** research/progress.ts on fake sessions and logs: no browser, no Jev. */

import { appendFileSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Deps } from "../research/progress/events.ts";
import { clip, describe as describeEvent, findLogs, findSessions } from "../research/progress/records.ts";
import { progress } from "../research/progress.ts";
import { tmpPath } from "./helpers.ts";

const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`;

const START = {
  type: "run_start",
  task: "hotel_filter",
  goal: "Filter the hotels",
  max_attempts: 3,
  flow: "v2",
  session: "new",
  started_at: "2026-11-27T10:00:00.000Z",
};
const T0 = Date.parse(START.started_at);

/** A WEBHAND_HOME with an open session whose log holds lines; the state also holds a secret value. */
function home(lines: Record<string, unknown>[], options: { id?: string; lockPid?: number; meta?: unknown } = {}) {
  const root = tmpPath();
  const log = join(root, "runs", "20261127T100000", "hotel_filter.jsonl");
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, lines.map(line).join(""));
  const stem = options.id ? `session-${options.id}` : "session";
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", `${stem}.json`),
    JSON.stringify({
      task: "hotel_filter",
      log,
      started: T0 / 1000,
      max_attempts: 3,
      plan: { attempt: 1, values: [{ label: "password", value: "hunter2-secret" }] },
      page: { text: "PAGE BODY TEXT" },
      ...(options.meta ? { meta: options.meta } : {}),
    }),
  );
  if (options.lockPid) writeFileSync(join(root, "state", `${stem}.lock`), String(options.lockPid));
  return { root, log };
}

function capture() {
  let out = "";
  const io = {
    out: (text: string) => {
      out += text;
    },
  };
  return { io, text: () => out };
}

/** A clock that moves by each sleep; `onSleep` changes the files between polls. */
function clock(onSleep: (tick: number) => void = () => {}): Deps {
  let now = T0 + 5_000;
  let tick = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      onSleep(++tick);
    },
  };
}

describe("progress", () => {
  it("finds the open session and its lock, and only takes the fields it shows", () => {
    const { root, log } = home([START], { id: "a1", lockPid: process.pid });
    const [session] = findSessions([root]);
    expect(session).toMatchObject({
      id: "a1",
      log,
      task: "hotel_filter",
      attempt: 1,
      maxAttempts: 3,
      busy: process.pid,
    });
    expect(JSON.stringify(session)).not.toContain("hunter2");
    expect(JSON.stringify(session)).not.toContain("PAGE BODY");
  });

  it("finds sessions in a batch out dir and run logs newest first", () => {
    const out = tmpPath();
    const a = home([START]);
    const nested = join(out, "homes", "hotel_filter-1-abc");
    mkdirSync(dirname(nested), { recursive: true });
    renameSync(a.root, nested);
    expect(findSessions([out])).toHaveLength(1);
    writeFileSync(join(out, "results.jsonl"), line({ task: "x" }));
    expect(findLogs([out]).map((p) => p.endsWith("hotel_filter.jsonl"))).toEqual([true]);
  });

  it("prints the run so far and what it is doing now, once", async () => {
    const { root } = home(
      [
        START,
        { type: "plan", attempt: 1, steps: ["1. Open the filter"], values: ["city"] },
        { type: "call", provider: "typesafe" },
        {
          type: "step",
          step: 1,
          attempt: 1,
          decided_by: "jev",
          confidence: 0.9,
          operation: "TYPE",
          action: "City\u001b[31m",
          value: "city",
          text_chars: 5,
        },
        { type: "step_result", step: 1, page_changed: false },
        { type: "escalation", attempt: 1, reason: "ESCALATE", detail: "Jev asked" },
      ],
      { id: "a1" },
    );
    const { io, text } = capture();
    expect(await progress(["--dir", root, "--once", "--events"], io, clock())).toBe(0);
    const out = text();
    expect(out).toContain("hotel_filter --id a1");
    expect(out).toContain("start  task=hotel_filter max_attempts=3 flow=v2 session=new");
    expect(out).toContain("plan (attempt 1): 1 step values: city");
    expect(out).toContain('step 1 (attempt 1): TYPE "City [31m" value=city [jev 0.90]');
    expect(out).toContain("step 1: the page did not change");
    expect(out).toContain("STOP (attempt 1): ESCALATE — Jev asked");
    expect(out).toContain("now: attempt 1/3 elapsed 5s — attempt stopped with ESCALATE; Claude decides");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("PAGE BODY");
  });

  it("follows a log as it grows and stops at run_end, without the evidence", async () => {
    const { root, log } = home([START]);
    const deps = clock((tick) => {
      if (tick === 2) {
        appendFileSync(
          log,
          line({ type: "step", step: 1, attempt: 1, decided_by: "jev", operation: "CLICK", action: "Search" }),
        );
      }
      if (tick === 3) appendFileSync(log, '{"type":"escalation","attempt":1,"reason":"GOAL_'); // still being written
      if (tick === 4) appendFileSync(log, 'REPORTED","detail":"Jev chose DONE"}\n');
      if (tick === 6) {
        appendFileSync(
          log,
          line({
            type: "run_end",
            status: "done",
            verified: true,
            attempts: 1,
            actions: 1,
            decisions: 2,
            elapsed_ms: 9_000,
            evidence: { expected: "Hotel Secret Answer" },
          }),
        );
      }
    });
    const { io, text } = capture();
    expect(await progress(["--dir", root, "--log", log], io, deps)).toBe(0);
    const out = text();
    expect(out).toContain(`── hotel_filter  log: ${log}`);
    expect(out).toMatch(/\+ {4}6s step 1 \(attempt 1\): CLICK "Search" \[jev\]/);
    expect(out).toContain("STOP (attempt 1): GOAL_REPORTED — Jev chose DONE");
    expect(out).toContain("END    status=done verified=true attempts=1 actions=1 decisions=2 elapsed=9s");
    expect(out).not.toContain("Hotel Secret Answer");
  });

  it("names the webarena files when they appear, without reading them", async () => {
    const { root, log } = home([START]);
    const taskDir = dirname(log);
    appendFileSync(log, line({ type: "run_end", status: "done", attempts: 1 }));
    const { io, text } = capture();
    const live = join(taskDir, "webhand.jsonl");
    writeFileSync(live, line(START));
    const deps = clock((tick) => {
      if (tick === 1) appendFileSync(live, line({ type: "run_end", status: "done", attempts: 1 }));
      if (tick === 2) writeFileSync(join(taskDir, "agent_response.json"), '{"retrieved_data":["x"]}');
      if (tick === 3) writeFileSync(join(taskDir, "eval_result.json"), '{"expected":"answer"}');
    });
    expect(await progress(["--dir", root, "--log", live], io, deps)).toBe(0);
    expect(text()).toContain("── hotel_filter  log:");
    expect(text()).not.toContain("── webhand ");
    expect(text()).toContain(`wrote ${join(taskDir, "agent_response.json")}`);
    expect(text()).toContain(`wrote ${join(taskDir, "eval_result.json")}`);
    expect(text()).not.toContain("expected");
  });

  it("says when nothing is open, with the last run's end", async () => {
    const { root, log } = home([START, { type: "run_end", status: "blocked", verified: false, attempts: 2 }]);
    rmSync(join(root, "state"), { recursive: true });
    const { io, text } = capture();
    expect(await progress(["--dir", root, "--once", "--events"], io, clock())).toBe(0);
    expect(text()).toContain(`Last run log: ${log}`);
    expect(text()).toContain("END    status=blocked verified=false attempts=2");
  });

  it("cleans and clips text from the log", () => {
    expect(clip("a\u0007b‮c  d", 20)).toBe("a b c d");
    expect(clip("x".repeat(10), 5)).toBe("xxxx…");
    expect(describeEvent({ type: "screenshot" })).toBeNull();
    for (const type of ["known_offered", "into_view", "more", "collect_round", "finding", "window_ignored", "x"]) {
      expect(describeEvent({ type, attempt: 1 })).toBeNull();
    }
    expect(describeEvent({ type: "self_verify", attempt: 2, met: 1, unmet: 0, unknown: 2 })).toBe(
      "self-check (attempt 2): met 1, unmet 0, unknown 2",
    );
    expect(
      describeEvent({ type: "check", results: [{ verdict: "PASS" }, { verdict: "FAIL" }, { verdict: "PASS" }] }),
    ).toBe("check: PASS 2, FAIL 1");
  });

  it("rejects unknown arguments", async () => {
    const { io, text } = capture();
    expect(await progress(["--nope"], io, clock())).toBe(2);
    expect(text()).toContain("usage:");
  });
});

describe("progress board", () => {
  const NOW = Date.parse("2026-11-27T11:00:00.000Z");
  const ago = (minutes: number) => NOW - minutes * 60_000;

  interface Fake {
    task: string;
    started: number;
    events?: Record<string, unknown>[];
    end?: Record<string, unknown>;
    quiet?: number;
    session?: { id: string; lockPid?: number; browserPid?: number };
    score?: Record<string, unknown>;
  }

  /** Runs under one WEBHAND_HOME-like folder; WebArena runs in OUT_DIR/ID/webhand.jsonl as research/webarena.ts writes. */
  function runs(fakes: Fake[]) {
    const root = tmpPath();
    mkdirSync(join(root, "state"), { recursive: true });
    fakes.forEach((fake, i) => {
      const id = fake.task.startsWith("webarena_") ? fake.task.slice("webarena_".length) : null;
      const log = id
        ? join(root, "runs", "webarena", `out${i}`, id, "webhand.jsonl")
        : join(root, "runs", `stamp${i}`, `${fake.task}.jsonl`);
      mkdirSync(dirname(log), { recursive: true });
      const start = {
        type: "run_start",
        task: fake.task,
        goal: "secret goal text",
        max_attempts: 3,
        started_at: new Date(fake.started).toISOString(),
      };
      writeFileSync(log, [start, ...(fake.events ?? []), ...(fake.end ? [fake.end] : [])].map(line).join(""));
      const quiet = (fake.quiet ?? 0) * 60_000;
      utimesSync(log, new Date(NOW - quiet), new Date(NOW - quiet));
      if (fake.score) writeFileSync(join(dirname(log), "eval_result.json"), JSON.stringify(fake.score));
      if (fake.session) {
        const stem = `session-${fake.session.id}`;
        writeFileSync(
          join(root, "state", `${stem}.json`),
          JSON.stringify({
            task: fake.task,
            log,
            started: fake.started / 1000,
            max_attempts: 3,
            plan: { attempt: 1, values: [{ label: "pw", value: "hunter2-secret" }] },
            ...(fake.session.browserPid ? { pid: fake.session.browserPid } : {}),
          }),
        );
        if (fake.session.lockPid) writeFileSync(join(root, "state", `${stem}.lock`), String(fake.session.lockPid));
      }
    });
    return root;
  }

  const end = (status: string, outcome: string, verified: boolean | null, minutes: number) => ({
    type: "run_end",
    status,
    verified,
    attempts: 1,
    attempt_outcomes: [{ attempt: 1, outcome }],
    elapsed_ms: minutes * 60_000,
    evidence: { expected: "Secret Expected Answer" },
  });
  const step = { type: "step", step: 1, attempt: 1, decided_by: "jev", operation: "CLICK", action: "Search" };
  const fixed: Deps = { now: () => NOW, sleep: async () => {} };

  async function board(root: string, ...args: string[]) {
    const { io, text } = capture();
    expect(
      await progress(["--dir", root, "--once", "--since", new Date(ago(60)).toISOString(), ...args], io, fixed),
    ).toBe(0);
    return text();
  }

  // 5 + 5 planned; 3 research runs and 3 WebArena runs so far, one of each still open.
  const mixed = () =>
    runs([
      { task: "old_task", started: ago(120), end: end("done", "GOAL_REPORTED", true, 1), quiet: 119 },
      { task: "hotel_filter", started: ago(50), end: end("done", "GOAL_REPORTED", true, 2), quiet: 48 },
      { task: "qty_stepper", started: ago(45), end: end("blocked", "STUCK", false, 3), quiet: 42 },
      {
        task: "webarena_94",
        started: ago(40),
        end: end("done", "GOAL_REPORTED", null, 1),
        quiet: 39,
        score: { score: 1, status: "success", evaluators_results: "EXPECTED 42.00" },
      },
      {
        task: "webarena_157",
        started: ago(35),
        end: end("done", "GOAL_REPORTED", null, 1),
        quiet: 34,
        score: { score: 0, status: "failure", evaluators_results: "EXPECTED 9.99" },
      },
      { task: "cookie_wall", started: ago(20), events: [step], quiet: 1, session: { id: "a", lockPid: process.pid } },
      { task: "webarena_118", started: ago(15), events: [step], quiet: 9, session: { id: "b" } },
    ]);

  it("counts each skill against the plan, with results, kinds, ETA, and open runs", async () => {
    const out = await board(mixed(), "--research", "5", "--webarena", "5");
    expect(out).toContain("Plan 10 (--research 5 --webarena 5): done 4, running 2, not started 4");
    // 4 done in the 50 minutes since the first counted run: 6 left at 12m30s each.
    expect(out).toContain("(in ~1h15m; 12m30s per run from 4 done)");
    expect(out).toMatch(/webhand-research +plan 5, done 2, not started 2, running 1 +verify\(\): OK 1, NG 1/);
    expect(out).toMatch(/webarena-research +plan 5, done 2, not started 2, running 1 +score: OK 1, NG 1, unscored 0/);
    expect(out).toContain("Not OK or unscored, by kind: blocked/STUCK 1 · done/GOAL_REPORTED score 0 1");
    expect(out).toMatch(/cookie_wall --id a .* moving: a webhand command runs/);
    expect(out).toMatch(/webarena_118 --id b .* STALLED\? no event for 9m00s and no webhand command running/);
    expect(out).toContain('last: step 1 (attempt 1): CLICK "Search" [jev]');
    expect(out).not.toContain("old_task"); // Started before --since.
    for (const secret of ["Secret Expected", "EXPECTED", "hunter2", "secret goal"]) expect(out).not.toContain(secret);
  });

  it("shows no totals or ETA without a plan", async () => {
    const out = await board(mixed());
    expect(out).toContain("Plan: unknown");
    expect(out).not.toMatch(/ETA \d/);
    expect(out).toMatch(/webhand-research +runs 3, running 1/);
  });

  it("fills a task list in start order: re-runs and other tasks take no slot", async () => {
    const root = runs([
      { task: "qty_stepper", started: ago(50), end: end("blocked", "STUCK", false, 3), quiet: 47 },
      { task: "qty_stepper", started: ago(40), end: end("done", "GOAL_REPORTED", true, 3), quiet: 37 },
      { task: "terms_scroll", started: ago(30), end: end("done", "GOAL_REPORTED", false, 3), quiet: 27 },
      { task: "webarena_94", started: ago(20), quiet: 10 },
    ]);
    const out = await board(root, "--tasks", "qty_stepper,qty_stepper,hotel_filter,94");
    expect(out).toContain("Plan 4 (--tasks 4): done 3, running 0, not started 1");
    expect(out).toContain("Not started: hotel_filter");
    expect(out).toMatch(/webhand-research .* verify\(\): OK 1, NG 2 +\(1 not taking a plan slot\)/);
    expect(out).toContain("done/GOAL_REPORTED (verify NG) 1");
    expect(out).toMatch(/terms_scroll +NG done\/GOAL_REPORTED \(verify NG\).*\(not in plan\)/);
    // No run_end, no session, quiet: interrupted, and counted as done.
    expect(out).toMatch(/webarena_94 +INTERRUPTED unscored interrupted \(no run_end\)/);
  });

  it("tells a command that runs without events from one that moves, and a gone browser", async () => {
    const dead = 2 ** 22 + 12345;
    const root = runs([
      { task: "hotel_filter", started: ago(30), events: [step], quiet: 7, session: { id: "a", lockPid: process.pid } },
      { task: "guest_add", started: ago(10), events: [step], quiet: 1, session: { id: "b", browserPid: dead } },
    ]);
    const out = await board(root, "--stall", "5");
    expect(out).toContain(`STALLED? a webhand command runs (pid ${process.pid}) but no event for 7m00s`);
    expect(out).toContain("STALLED? the browser is gone");
  });

  it("counts a run already open when it starts, however old", async () => {
    const root = runs([{ task: "hotel_filter", started: ago(300), events: [step], session: { id: "a" } }]);
    const { io, text } = capture();
    expect(await progress(["--dir", root, "--once", "--total", "2"], io, fixed)).toBe(0);
    expect(text()).toContain("Plan 2 (--total 2): done 0, running 1, not started 1");
    expect(text()).toContain("when this started; --since to change");
  });

  it("writes a new snapshot off a terminal only when something changed", async () => {
    const root = mixed();
    let now = NOW;
    let ticks = 0;
    const { io, text } = capture();
    const deps: Deps = {
      now: () => now,
      sleep: async () => {
        now += 1000;
        if (++ticks === 3)
          appendFileSync(
            join(root, "runs", "stamp5", "cookie_wall.jsonl"),
            line(end("done", "GOAL_REPORTED", true, 20)),
          );
        if (ticks === 5) throw new Error("stop");
      },
    };
    await expect(progress(["--dir", root, "--since", "2h"], io, deps)).rejects.toThrow("stop");
    expect(text().match(/webhand research progress/g)).toHaveLength(2);
  });

  it("rejects a task list together with counts, and a bad --since", async () => {
    const { io } = capture();
    expect(await progress(["--tasks", "a", "--total", "2"], io, fixed)).toBe(2);
    expect(await progress(["--since", "yesterday"], io, fixed)).toBe(2);
  });
});
