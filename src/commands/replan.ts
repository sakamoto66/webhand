import * as agent from "../agent.ts";
import type { Args } from "../args.ts";
import { browserUrl } from "../engines/chrome.ts";
import { logOnce, safeUrl } from "../metrics.ts";
import { describePlan, headline } from "../output.ts";
import { planText } from "../policies/base.ts";
import * as runbook from "../runbook.ts";
import * as session from "../session.ts";
import type { Value } from "../types.ts";

import { BUDGET, FAILED, OK, print, UNCERTAIN } from "./context.ts";
import { mergeValues, openableUrl, openPage, parseSteps, parseValues, requireSession } from "./shared.ts";

/** Claude revises the plan after an attempt fell short, and starts the next attempt. */
/** A `replan` that cannot be taken: the message after "REJECTED: ". Nothing has been saved yet. */
class ReplanRejected extends Error {}

/** The page --url names, as the browser opens it. null without --url. */
function replanUrl(args: Args, state: session.State): string | null {
  if (!args.url) return null;
  // A path without a scheme is a local file, as the catalog shows a learned page (tasks/fixtures/...).
  let url: string;
  try {
    url = runbook.resolveUrl(args.url);
  } catch (error) {
    if (!(error instanceof runbook.RunbookError)) throw error;
    throw new ReplanRejected(error.message.replace("start_url", "--url"));
  }
  if (!openableUrl(url)) {
    throw new ReplanRejected("--url needs an http, https, or file URL, or a local file path");
  }
  // As start does: the Windows Chrome on WSL opens a local file by its Windows path (round 19).
  return browserUrl(url, state.chrome ?? "linux");
}

/** A value of --compare, --collect or --more: "none" turns it off. */
function switched(value: string): string | null {
  return value === "none" ? null : value;
}

/** Applies the steps, values, compare, collect and more Claude gave to the plan. */
function applyReplanPlan(args: Args, state: session.State): void {
  const plan = state.plan;
  if (args.step.length) {
    const steps = parseSteps(args.step);
    if (steps.some((step) => step.actor === "human") && !state.headed) {
      throw new ReplanRejected("[person] steps need a visible window, and this run is headless");
    }
    plan.steps = steps;
  }
  plan.values = mergeValues(plan.values, parseValues(args.value));
  if (args.compare) plan.compare = switched(args.compare);
  plan.compared = null; // Each attempt compares again from the top.
  if (args.collect) plan.collect = switched(args.collect);
  plan.collected = null; // and collects again.
  if (args.more) plan.more = switched(args.more);
  if (plan.compare && plan.collect) {
    throw new ReplanRejected("use --compare or --collect, not both (turn one off with none)");
  }
  if (plan.more && !plan.compare && !plan.collect) {
    throw new ReplanRejected("--more needs --compare or --collect (turn it off with --more none)");
  }
}

/** Replaces Claude's region choice, on top of what was learned (--read alone keeps the regions). Whether it changed. */
function applyReplanView(args: Args, state: session.State): boolean {
  if (!(args.focus.length || args.skip.length || args.read.length)) return false;
  const regions = args.focus.length || args.skip.length;
  const earlier = state.view_claude ?? { focus: [], skip: [] };
  state.view_claude = {
    focus: regions ? args.focus : earlier.focus,
    skip: regions ? args.skip : earlier.skip,
    read: args.read.length ? args.read : earlier.read,
  };
  state.view = runbook.view(state.view_learned, state.view_claude);
  return true;
}

/** Closes the attempt that ended and opens the next: the outcome, Claude's reason, and the new plan, saved and logged. */
function startNextAttempt(args: Args, state: session.State, url: string | null): void {
  const plan = state.plan;
  const ended = state.outcome || "CLAUDE_STOPPED";
  state.outcomes.push({ attempt: plan.attempt, outcome: ended, reason: args.reason });
  plan.notes.push(`Attempt ${plan.attempt} ended with ${ended}. Claude: ${args.reason}`);
  plan.attempt += 1;
  state.outcome = null;
  state.attempt_decisions = 0;
  session.save(state);
  logOnce(state.log, "attempt_end", { attempt: plan.attempt - 1, outcome: ended, reason: args.reason });
  logOnce(state.log, "plan", {
    attempt: plan.attempt,
    steps: planText(plan),
    values: plan.values.map((v: Value) => v.label),
    view: state.view ?? null,
    ...(plan.compare ? { compare: plan.compare } : {}),
    ...(plan.collect ? { collect: plan.collect } : {}),
    ...(plan.more ? { more: plan.more } : {}),
    restart: args.restart,
    ...(url ? { url: safeUrl(url) } : {}),
    source: "claude",
  });
}

export async function commandReplan(args: Args): Promise<number> {
  const state = requireSession();
  const plan = state.plan;
  if (state.outcome === agent.UNCERTAIN) {
    print("REJECTED: the last action may have happened, so the run cannot continue. Run: finish --status error");
    return UNCERTAIN;
  }
  if (plan.attempt >= state.max_attempts) {
    print(`ATTEMPTS EXHAUSTED (${state.max_attempts}). Run: webhand finish --status blocked`);
    return BUDGET;
  }
  let url: string | null;
  let viewChanged: boolean;
  try {
    if (args.url && args.restart) throw new ReplanRejected("use --url or --restart, not both");
    url = replanUrl(args, state);
    applyReplanPlan(args, state);
    viewChanged = applyReplanView(args, state);
  } catch (error) {
    if (!(error instanceof ReplanRejected)) throw error;
    print(`REJECTED: ${error.message}`);
    return FAILED;
  }
  startNextAttempt(args, state, url);
  // Navigation only; no earlier mutation is repeated.
  if (url) await openPage(state, url, true);
  else if (args.restart) await openPage(state, state.start_url, true);
  else if (viewChanged) await openPage(state); // Observe again with the new regions.
  print(
    `${describePlan(plan, state.view ?? null)}\nATTEMPT ${plan.attempt}/${state.max_attempts}\n${headline(state.page)}`,
  );
  print("NEXT: webhand run");
  return OK;
}
