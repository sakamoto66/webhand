import * as agent from "../agent/index.ts";
import type { Args } from "../args.ts";
import { logOnce, safeUrl } from "../core/metrics.ts";
import type { Value } from "../core/types.ts";
import { engineFor } from "../engines/index.ts";
import { ENFORCING_ENGINES } from "../engines/types.ts";
import { hostAllowed } from "../explore.ts";
import { describePlan, headline } from "../output.ts";
import { planText } from "../policies/base.ts";
import * as runbook from "../storage/runbook/index.ts";
import * as session from "../storage/session.ts";
import { BUDGET, FAILED, OK, print, UNCERTAIN } from "./context.ts";
import {
  allowControlOption,
  autonomyOptions,
  collectOption,
  compareOption,
  fileOption,
  idOption,
  moreOption,
  valueOption,
  viewOptions,
} from "./options.ts";
import { commandRun } from "./run.ts";
import { mergeValues, openPage, parseFiles, parseSteps, parseValues, requireSession, resolveCliUrl } from "./shared.ts";
import type { CommandDef } from "./types.ts";

/** A `replan` that cannot be taken: the message after "REJECTED: ". Nothing has been saved yet. */
class ReplanRejected extends Error {}

/**
 * Adds --service to a session started without one: Jev gets its facts, and its regions and allowed_domains apply, as
 * with `start --service`. A session keeps the service it has. Whether it was added.
 */
function applyReplanService(args: Args, state: session.State): boolean {
  if (!args.service) return false;
  if (state.service) {
    if (state.service === args.service) return false;
    throw new ReplanRejected(`this session already uses service ${state.service}`);
  }
  const info = runbook.loadService(args.service);
  if (!info) throw new ReplanRejected(`no service information for ${args.service} (see: webhand catalog)`);
  // An explore session is limited by its own --allow-domain.
  const allowed = state.explore ? [] : (info.allowed_domains ?? []);
  if (allowed.length) {
    const engine = engineFor(state.engine);
    if (!engine.capabilities.allowedDomains) {
      throw new ReplanRejected(
        `${engine.label} cannot enforce service ${args.service}'s allowed_domains. ${ENFORCING_ENGINES}`,
      );
    }
    const outside = [String(state.page.url), state.start_url].some((url) => !hostAllowed(url, allowed));
    if (outside) {
      throw new ReplanRejected(
        `the session's page or start URL is outside service ${args.service}'s allowed_domains (${allowed.join(", ")})`,
      );
    }
    state.allowed_domains = allowed;
  }
  state.service = args.service;
  state.plan.service = { description: info.description, facts: info.facts };
  // A session without a service has no runbook, so the service's regions are all that is saved.
  state.view_saved = runbook.view(runbook.serviceView(info), state.view_saved);
  state.view = runbook.view(state.view_saved, state.view_claude);
  return true;
}

/** The page --url names, as the browser opens it. null without --url. */
function replanUrl(args: Args, state: session.State): string | null {
  if (!args.url) return null;
  const resolved = resolveCliUrl(args.url, state.chrome ?? "linux");
  if (!resolved.ok) throw new ReplanRejected(resolved.reason);
  if (state.allowed_domains?.length && !hostAllowed(resolved.url, state.allowed_domains)) {
    throw new ReplanRejected(`--url is outside allowed_domains (${state.allowed_domains.join(", ")})`);
  }
  if (state.explore && !hostAllowed(resolved.url, state.explore.allow)) {
    throw new ReplanRejected(`--url is outside --allow-domain (${state.explore.allow.join(", ")})`);
  }
  return resolved.url;
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
  if (args.file.length) plan.files = mergeValues(plan.files ?? [], parseFiles(args.file));
  if (args.compare) plan.compare = switched(args.compare);
  plan.compared = null; // Each attempt compares again from the top.
  if (args.collect) plan.collect = switched(args.collect);
  plan.collected = null; // and collects again.
  if (args.allow_control.length) {
    if (!state.read_only) throw new ReplanRejected("--allow-control needs a read-only session (start --read-only)");
    state.read_only.allow = [...new Set([...state.read_only.allow, ...args.allow_control])];
  }
  if (args.more) plan.more = switched(args.more);
  if (args.expect?.length) {
    const expects = args.expect.map((c: string) => c.trim()).filter(Boolean);
    plan.expects = expects.length === 1 && expects[0] === "none" ? undefined : expects;
  }
  if (args.two_stage) plan.two_stage = true;
  if (args.recover) plan.recover = true;
  if (plan.compare && plan.collect) {
    throw new ReplanRejected("use --compare or --collect, not both (turn one off with none)");
  }
  if (plan.more && !plan.compare && !plan.collect) {
    throw new ReplanRejected("--more needs --compare or --collect (turn it off with --more none)");
  }
}

/** Replaces Claude's region choice, on top of the saved service/runbook view (--read alone keeps the regions). Whether it changed. */
function applyReplanView(args: Args, state: session.State): boolean {
  if (!(args.focus.length || args.skip.length || args.read.length)) return false;
  const regions = args.focus.length || args.skip.length;
  const earlier = state.view_claude ?? { focus: [], skip: [] };
  state.view_claude = {
    focus: regions ? args.focus : earlier.focus,
    skip: regions ? args.skip : earlier.skip,
    read: args.read.length ? args.read : earlier.read,
  };
  state.view = runbook.view(state.view_saved, state.view_claude);
  return true;
}

/** Logs the plan the current attempt now has. */
function logPlan(args: Args, state: session.State, url: string | null, extra: Record<string, unknown> = {}): void {
  const plan = state.plan;
  logOnce(state.log, "plan", {
    attempt: plan.attempt,
    steps: planText(plan),
    values: plan.values.map((v: Value) => v.label),
    view: state.view ?? null,
    ...(args.service ? { service: state.service } : {}),
    ...(plan.compare ? { compare: plan.compare } : {}),
    ...(plan.collect ? { collect: plan.collect } : {}),
    ...(plan.more ? { more: plan.more } : {}),
    restart: args.restart,
    ...(url ? { url: safeUrl(url) } : {}),
    ...extra,
    source: "claude",
  });
}

/** Nothing ran in this attempt, so there is nothing to try again: the new plan stays in it. */
function reviseAttempt(args: Args, state: session.State, url: string | null): void {
  state.plan.notes.push(`Plan revised before attempt ${state.plan.attempt} ran. Claude: ${args.reason}`);
  session.save(state);
  logPlan(args, state, url, { reason: args.reason });
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
  state.attempt_unused = true;
  session.save(state);
  logOnce(state.log, "attempt_end", { attempt: plan.attempt - 1, outcome: ended, reason: args.reason });
  logPlan(args, state, url);
}

async function commandReplan(args: Args): Promise<number> {
  const state = requireSession();
  const plan = state.plan;
  if (state.outcome === agent.UNCERTAIN) {
    print("REJECTED: the last action may have happened, so the run cannot continue. Run: finish --status error");
    return UNCERTAIN;
  }
  // Absent in a session saved by an earlier version, which counts as used.
  const unused = state.attempt_unused === true;
  if (!unused && plan.attempt >= state.max_attempts) {
    print(`ATTEMPTS EXHAUSTED (${state.max_attempts}). Run: webhand finish --status blocked`);
    return BUDGET;
  }
  let url: string | null;
  let viewChanged: boolean;
  try {
    if (args.url && args.restart) throw new ReplanRejected("use --url or --restart, not both");
    const added = applyReplanService(args, state); // Before --url, which must be inside its allowed_domains.
    url = replanUrl(args, state);
    applyReplanPlan(args, state);
    viewChanged = applyReplanView(args, state) || added;
  } catch (error) {
    if (!(error instanceof ReplanRejected)) throw error;
    print(`REJECTED: ${error.message}`);
    return FAILED;
  }
  if (unused) reviseAttempt(args, state, url);
  else startNextAttempt(args, state, url);
  // Navigation only; no earlier mutation is repeated.
  if (url) await openPage(state, url, true);
  else if (args.restart) await openPage(state, state.start_url, true);
  else if (viewChanged) await openPage(state); // Observe again with the new regions.
  if (args.run) return commandRun({ ...args, value: [], file: [], human_done: false });
  print(
    `${describePlan(plan, state.view ?? null)}\nATTEMPT ${plan.attempt}/${state.max_attempts}\n${headline(state.page)}`,
  );
  print("NEXT: webhand run");
  return OK;
}

export const replanCommand: CommandDef = {
  name: "replan",
  session: "required",
  spec: () => ({
    help: "Claude: revise the plan and start the next attempt (the same one if nothing ran in it)",
    options: [
      idOption(),
      { name: "reason", type: "string", required: true, help: "Why the last attempt fell short; Jev sees it" },
      { name: "step", type: "string", multiple: true, help: "Replace the steps" },
      valueOption(),
      fileOption(),
      { name: "service", type: "string", help: "Add saved service information to a session started without one" },
      { name: "restart", type: "boolean", help: "Open the start URL again before the next attempt" },
      { name: "url", type: "string", help: "Open this URL before the next attempt instead (another way in)" },
      ...viewOptions(),
      compareOption(),
      collectOption(),
      moreOption(),
      ...autonomyOptions(),
      allowControlOption(),
      { name: "run", type: "boolean", help: "Hand to Jev right away for the next attempt in the same command" },
    ],
  }),
  run: commandReplan,
};
