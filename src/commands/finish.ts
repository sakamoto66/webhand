/** The `finish` command. */

import { readFileSync } from "node:fs";
import * as agent from "../agent/index.ts";
import type { Args } from "../args.ts";
import type { Browser } from "../browser/index.ts";
import { describeError, show } from "../core/format.ts";
import { readJsonLines } from "../core/fs.ts";
import { logOnce, summarize } from "../core/metrics.ts";
import type { ModelCall, Verdict } from "../core/types.ts";
import { type HarStopResult, stopHarRecorder } from "../har/session.ts";
import { planText } from "../policies/base.ts";
import * as batch from "../storage/batch.ts";
import { memoryEnabled, SiteMemory } from "../storage/memory.ts";
import * as session from "../storage/session.ts";
import { CliExit, getContext, OK, print } from "./context.ts";
import { idOption } from "./options.ts";
import { attach } from "./shared.ts";
import type { CommandDef } from "./types.ts";

function runTotals(log: string): Record<string, unknown> {
  const calls: ModelCall[] = [];
  const escalations: Record<string, number> = {};
  const decidedBy: Record<string, number> = {};
  let handoffs = 0;
  let handoffChars = 0;
  let notVisible = 0;
  let stale = 0;
  for (const { type, ...event } of readJsonLines(readFileSync(log, "utf8"))) {
    if (type === "call") calls.push(event as unknown as ModelCall);
    else if (type === "escalation") {
      const reason = String(event.reason);
      escalations[reason] = (escalations[reason] ?? 0) + 1;
    } else if (type === "step") {
      const by = String(event.decided_by);
      decidedBy[by] = (decidedBy[by] ?? 0) + 1;
    } else if (type === "not_visible") notVisible += 1;
    else if (type === "stale") stale += 1;
    else if (type === "handoff") {
      handoffs += 1;
      handoffChars += Number(event.chars ?? 0);
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
  let batchNote = "";
  if (state.batch) {
    const rowStatus: batch.BatchRowStatus = state.outcome === "UNCERTAIN" ? "uncertain" : args.status;
    const { nextPending, total } = batch.recordRowOutcome(state.batch.id, state.batch.row, {
      status: rowStatus,
      reason: args.reason,
      attempts: plan.attempt,
      log: state.log,
    });
    const nextPart = nextPending != null ? ` next=${nextPending}` : " batch_done=true";
    batchNote = ` batch=${state.batch.id} row=${state.batch.row}/${total}${nextPart}`;
  }
  print(
    `FINISHED status=${args.status} verified=${show(verdict.success)} attempts=${plan.attempt} log=${state.log}${harNote}${batchNote}`,
  );
  return OK;
}

export const finishCommand: CommandDef = {
  name: "finish",
  session: "required",
  spec: () => ({
    help: "Verify, log, and close Chrome",
    options: [
      idOption(),
      {
        name: "status",
        type: "string",
        required: true,
        choices: ["done", "blocked", "budget", "error", "abandoned"],
      },
      { name: "reason", type: "string" },
    ],
  }),
  run: commandFinish,
};
