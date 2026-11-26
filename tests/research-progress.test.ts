/** research/progress.ts on fake sessions and logs: no browser, no Jev. */

import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { clip, type Deps, describe as describeEvent, findLogs, findSessions, progress } from "../research/progress.ts";
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
    expect(await progress(["--dir", root, "--once"], io, clock())).toBe(0);
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
    expect(text()).toContain(`wrote ${join(taskDir, "agent_response.json")}`);
    expect(text()).toContain(`wrote ${join(taskDir, "eval_result.json")}`);
    expect(text()).not.toContain("expected");
  });

  it("says when nothing is open, with the last run's end", async () => {
    const { root, log } = home([START, { type: "run_end", status: "blocked", verified: false, attempts: 2 }]);
    rmSync(join(root, "state"), { recursive: true });
    const { io, text } = capture();
    expect(await progress(["--dir", root, "--once"], io, clock())).toBe(0);
    expect(text()).toContain(`Last run log: ${log}`);
    expect(text()).toContain("END    status=blocked verified=false attempts=2");
  });

  it("cleans and clips text from the log", () => {
    expect(clip("a\u0007b‮c  d", 20)).toBe("a b c d");
    expect(clip("x".repeat(10), 5)).toBe("xxxx…");
    expect(describeEvent({ type: "screenshot" })).toBeNull();
    expect(describeEvent({ type: "self_verify", attempt: 2, text: "secret" })).toBe("self_verify (attempt 2)");
  });

  it("rejects unknown arguments", async () => {
    const { io, text } = capture();
    expect(await progress(["--nope"], io, clock())).toBe(2);
    expect(text()).toContain("usage:");
  });
});
