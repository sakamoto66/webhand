/** The `finish` command. */

import { readFileSync } from "node:fs";
import * as agent from "../agent.ts";
import type { Args } from "../args.ts";
import type { Browser } from "../browser.ts";
import { describeError, show } from "../format.ts";
import { type HarStopResult, stopHarRecorder } from "../har-session.ts";
import { memoryEnabled, SiteMemory } from "../memory.ts";
import { logOnce, summarize } from "../metrics.ts";
import { planText } from "../policies/base.ts";
import * as session from "../session.ts";
import type { ModelCall, Verdict } from "../types.ts";

import { CliExit, getContext, OK, print } from "./context.ts";
import { attach } from "./shared.ts";

function runTotals(log: string): Record<string, unknown> {
  const calls: ModelCall[] = [];
  const escalations: Record<string, number> = {};
  const decidedBy: Record<string, number> = {};
  let handoffs = 0;
  let handoffChars = 0;
  let notVisible = 0;
  let stale = 0;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { type, ...event } = JSON.parse(line);
    if (type === "call") calls.push(event as ModelCall);
    else if (type === "escalation") escalations[event.reason] = (escalations[event.reason] ?? 0) + 1;
    else if (type === "step") decidedBy[event.decided_by] = (decidedBy[event.decided_by] ?? 0) + 1;
    else if (type === "not_visible") notVisible += 1;
    else if (type === "stale") stale += 1;
    else if (type === "handoff") {
      handoffs += 1;
      handoffChars += event.chars;
    }
  }
  return {
    ...summarize(calls),
    escalations,
    decided_by: decidedBy,
    handoffs,
    handoff_chars: handoffChars,
    not_visible: notVisible,
    stale,
  };
}

/** Verifies the page independently when a verifier was given. The status is what the agent claims, nothing more. */
export async function commandFinish(args: Args): Promise<number> {
  const state = session.load();
  if (state === null) throw new CliExit("No active session. Run: webhand start");
  let verdict: Verdict = { success: null, evidence: "no verifier" };
  let harResult: HarStopResult | null = null;
  try {
    const verify = getContext().hooks.verify;
    if (verify) {
      const browser = await attach(state, null);
      try {
        verdict = await verify(browser as Browser, state); // A remote browser has evaluate, which is what verifiers use.
      } finally {
        await browser.close();
      }
    }
  } catch (error) {
    verdict = { success: false, evidence: describeError(error) };
  } finally {
    // Flush the HAR sidecar while Chrome is still alive so in-flight bodies can finish.
    if (state.har) harResult = await stopHarRecorder(state.har);
    await session.stopChrome(state);
    session.clear();
  }
  const plan = state.plan;
  // v2: a run that finished as done marks its steps as the way that worked.
  if (args.status === "done" && plan.flow === "v2" && memoryEnabled()) {
    new SiteMemory().confirm(state.history);
  }
  const outcomes = [...state.outcomes, { attempt: plan.attempt, outcome: state.outcome, reason: args.reason }];
  const totals = runTotals(state.log);
  logOnce(state.log, "run_end", {
    status: args.status,
    reason: args.reason,
    service: state.service ?? null,
    runbook: state.runbook ?? null,
    goal: plan.goal,
    plan: planText(plan),
    attempts: plan.attempt,
    attempt_outcomes: outcomes,
    actions: agent.executed(state.history).length,
    decisions: state.decisions,
    elapsed_ms: Math.round((Date.now() / 1000 - state.started) * 1000),
    verified: verdict.success,
    evidence: verdict.evidence,
    ...(harResult
      ? { har_entries: harResult.entries, ...(harResult.error ? { har_error: harResult.error } : {}) }
      : {}),
    ...totals,
  });
  const harNote = state.har ? ` har=${state.har.path}` : "";
  print(
    `FINISHED status=${args.status} verified=${show(verdict.success)} attempts=${plan.attempt} log=${state.log}${harNote}`,
  );
  return OK;
}

function parentAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Stops a long-running command on SIGTERM or SIGINT, or when the process that started it is gone,
 * and still saves and closes. npx does not pass SIGTERM on, so stopping an `npx webhand record` job
 * ends npx alone; its end is the signal here.
 */
export function stopSignals(): { stopped: () => boolean; release: () => void } {
  let stopped = false;
  const parent = process.ppid;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return {
    stopped: () => stopped || !parentAlive(parent),
    release: () => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    },
  };
}
