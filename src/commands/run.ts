/** The `run` command. */

import * as agent from "../agent.ts";
import { Budget, runAgent } from "../agent.ts";
import type { Args } from "../args.ts";
import { type Collector, collectScan } from "../collect.ts";
import { type Comparer, compareScan, type Reader } from "../compare.ts";
import { memoryEnabled, memoryUseEnabled, SiteMemory } from "../memory.ts";
import { logOnce, Recorder } from "../metrics.ts";
import { loadMore, type MoreChooser } from "../more.ts";
import { collectedLine, comparedLine } from "../output.ts";
import { inForce, refusal } from "../readonly.ts";
import type { Driver } from "../remote.ts";
import * as session from "../session.ts";
import { MutationUncertain, type Policy, PolicyError, StalePage } from "../types.ts";

import { BUDGET, CliExit, deps, FAILED, OK, print, UNCERTAIN } from "./context.ts";
import { report } from "./report.ts";
import {
  attach,
  browserView,
  exploreActionsLeft,
  jevDiagnostic,
  mergeValues,
  openPage,
  parseFiles,
  parseValues,
  recordFindings,
  requireSession,
} from "./shared.ts";

/** Jev works toward the goal until it needs Claude or a person. */
/** Why `run` cannot go on from the state's last outcome, as the exit code after saying so. null when it can. */
function rejectRun(args: Args, state: session.State): number | null {
  const outcome = state.outcome;
  if (outcome === agent.UNCERTAIN) {
    print("REJECTED: the last action may have happened. Run: webhand finish --status error");
    return UNCERTAIN;
  }
  if (outcome === agent.NEEDS_HUMAN && !args.human_done) {
    print("REJECTED: a person is acting. When they are done: run --human-done");
    return FAILED;
  }
  if (outcome === agent.NEEDS_VALUE && !args.value.length) {
    print("REJECTED: this field needs run --value 'LABEL=VALUE'");
    return FAILED;
  }
  if (
    [agent.GOAL_REPORTED, agent.BLOCKED, agent.STUCK, agent.ATTEMPT_BUDGET, agent.ESCALATE, agent.READ_ONLY].includes(
      outcome,
    )
  ) {
    print(
      `REJECTED: the attempt ended with ${outcome}. Run ${state.plan.flow === "v2" ? "answer, " : ""}replan, act, or finish`,
    );
    return FAILED;
  }
  return null;
}

/** Takes in what the person or Claude brought to this `run`: values, and a person's finished step. null when accepted. */
async function acceptRunInputs(args: Args, state: session.State): Promise<number | null> {
  if (args.value.length) {
    state.plan.values = mergeValues(state.plan.values, parseValues(args.value));
    logOnce(state.log, "values", {
      attempt: state.plan.attempt,
      labels: parseValues(args.value).map((v) => v.label),
    });
  }
  if (args.file.length) state.plan.files = mergeValues(state.plan.files ?? [], parseFiles(args.file));
  if (args.human_done) {
    if (state.outcome !== agent.NEEDS_HUMAN) {
      print("REJECTED: no person was asked to act");
      return FAILED;
    }
    logOnce(state.log, "human_step", { status: "done", attempt: state.plan.attempt });
    await openPage(state); // The person changed the page.
    state.history.push({
      step: state.history.length + 1,
      attempt: state.plan.attempt,
      kind: "human",
      operation: "HUMAN",
      action: "A person did the step that needed them",
      text: null,
      url: state.page.url,
      page_changed: true,
    });
  }
  return null;
}

/** What the scans before the agent loop (compare, collect) work with. */
interface RunScan {
  state: session.State;
  browser: Driver;
  policy: Policy;
  recorder: Recorder;
  /** With --more, a scan presses Claude's control for more items when the list ends. */
  more: () => ReturnType<typeof loadMore> | null;
  /** Pressing the control is an action: when its result is uncertain, the run stops as UNCERTAIN. */
  uncertain: (error: MutationUncertain, scan: string) => number;
}

/** With a criterion, compares the whole list once per attempt before anything is acted on. null when the run goes on. */
async function compareStep(ctx: RunScan): Promise<number | null> {
  const { state, browser, policy, recorder } = ctx;
  if (!state.plan.compare || state.plan.compared) return null;
  if (!("compare" in policy)) throw new CliExit("This chooser cannot compare items");
  let scan: Awaited<ReturnType<typeof compareScan>>;
  try {
    scan = await compareScan(browser, policy as unknown as Comparer, state.plan, state.plan.compare, recorder, {
      loadMore: ctx.more(),
    });
  } catch (error) {
    if (error instanceof MutationUncertain) return ctx.uncertain(error, "compare");
    if (!(error instanceof PolicyError || error instanceof StalePage)) throw error;
    // Only scrolls happened. The attempt goes on; run again, or replan.
    recorder.event("compare_failed", {
      attempt: state.plan.attempt,
      error: error.message,
      ...jevDiagnostic(error),
    });
    print(`COMPARE FAILED: ${error.message} Nothing was clicked or typed. Run again, or replan`);
    return FAILED;
  }
  state.plan.compared = scan.compared;
  state.page = scan.page;
  session.save(state);
  print(comparedLine(scan.compared));
  return null;
}

/** With a condition, collects the matching items once per attempt and gives them to Claude; nothing is acted on. */
async function collectStep(ctx: RunScan): Promise<number | null> {
  const { state, browser, policy, recorder } = ctx;
  if (!state.plan.collect || state.plan.collected) return null;
  if (!("collect" in policy)) throw new CliExit("This chooser cannot collect items");
  let scan: Awaited<ReturnType<typeof collectScan>>;
  try {
    scan = await collectScan(browser, policy as unknown as Collector, state.plan, state.plan.collect, recorder, {
      loadMore: ctx.more(),
    });
  } catch (error) {
    if (error instanceof MutationUncertain) return ctx.uncertain(error, "collect");
    if (!(error instanceof PolicyError || error instanceof StalePage)) throw error;
    recorder.event("collect_failed", {
      attempt: state.plan.attempt,
      error: error.message,
      ...jevDiagnostic(error),
    });
    print(`COLLECT FAILED: ${error.message} Nothing was clicked or typed. Run again, or replan`);
    return FAILED;
  }
  state.plan.collected = scan.collected;
  state.page = scan.page;
  session.save(state);
  print(collectedLine(scan.collected));
  print(
    "Nothing was clicked or typed, and the page is back where it was. Check these items against the goal and " +
      "write the answer from them. To put the answer into the page, give it as a value: run --value " +
      "'LABEL=VALUE' (Jev types only values). Otherwise: finish",
  );
  return OK;
}

/** The attempt's action limit; an exploring session also stops at its total, however many attempts it took. */
function attemptActions(state: session.State): number {
  const left = exploreActionsLeft(state);
  if (left === null) return state.max_actions;
  return Math.min(state.max_actions, agent.actionsIn(state.history, state.plan.attempt).length + left);
}

/** One attempt of the agent loop, and what the log and the state keep of how it ended. */
async function runAttempt(ctx: RunScan): Promise<agent.AgentResult> {
  const { state, browser, policy, recorder } = ctx;
  const result = await runAgent(
    browser,
    policy,
    state.plan,
    recorder,
    new Budget(attemptActions(state), state.max_decisions),
    {
      history: state.history,
      readOnly: inForce(state),
      page: state.page,
      decisions: state.attempt_decisions,
      // v2 remembers what its operations did, for the next run on the site (WEBHAND_MEMORY=0 turns it off).
      memory: state.plan.flow === "v2" && memoryEnabled() ? new SiteMemory(undefined, memoryUseEnabled()) : undefined,
      onChange: (page) => {
        state.page = page;
        session.save(state);
        recordFindings(state, browser, recorder);
      },
      onDecision: (count) => {
        state.attempt_decisions = count;
        state.decisions += 1;
      },
    },
  );
  state.page = result.page;
  state.outcome = result.outcome;
  recorder.event("escalation", {
    reason: result.outcome,
    attempt: state.plan.attempt,
    detail: result.detail,
    ...(result.jev ? { jev: result.jev } : {}),
  });
  if (agent.CHECKED_OUTCOMES.includes(result.outcome)) {
    await agent.checkPage(browser, recorder, "escalation", state.plan.attempt, result.page.url);
  }
  if (result.outcome === agent.NEEDS_HUMAN) {
    recorder.event("human_step", { status: "requested", attempt: state.plan.attempt });
  }
  session.save(state);
  return result;
}

export async function commandRun(args: Args): Promise<number> {
  const state = requireSession();
  if (exploreActionsLeft(state) === 0) {
    print("BUDGET EXHAUSTED for this exploring session. Run findings, then finish --status budget");
    return BUDGET;
  }
  const rejected = rejectRun(args, state) ?? (await acceptRunInputs(args, state));
  if (rejected !== null) return rejected;
  state.outcome = null;
  session.save(state);

  const policy = deps.policy();
  const browser = await attach(state, null, browserView(state));
  const recorder = new Recorder(state.log);
  const ctx: RunScan = {
    state,
    browser,
    policy,
    recorder,
    more: () => {
      const control = state.plan.more;
      if (!control) return null;
      if (!("more" in policy)) throw new CliExit("This chooser cannot find a control for more items");
      return loadMore(
        browser as Reader,
        policy as unknown as MoreChooser,
        state.plan,
        control,
        recorder,
        state.plan.attempt,
        inForce(state) ? (action) => refusal(action, inForce(state) as NonNullable<ReturnType<typeof inForce>>) : null,
      );
    },
    uncertain: (error, scan) => {
      recorder.event(`${scan}_failed`, { attempt: state.plan.attempt, error: error.message, uncertain: true });
      state.outcome = agent.UNCERTAIN;
      session.save(state);
      print(
        `OUTCOME ${agent.UNCERTAIN}: ${error.message} while loading more items. Do not repeat or replan. Run: webhand finish --status error`,
      );
      return UNCERTAIN;
    },
  };
  let result: agent.AgentResult;
  try {
    const stopped = (await compareStep(ctx)) ?? (await collectStep(ctx));
    if (stopped !== null) return stopped;
    result = await runAttempt(ctx);
  } finally {
    recordFindings(state, browser, recorder);
    await browser.close();
    recorder.close();
    await policy.close?.();
  }
  return report(state, result);
}
