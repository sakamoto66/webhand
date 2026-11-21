import * as agent from "../agent.ts";
import { execute } from "../agent.ts";
import type { Args } from "../args.ts";
import { Recorder } from "../metrics.ts";
import { render } from "../output.ts";
import { resolve } from "../policies/base.ts";
import { inForce, refusal } from "../readonly.ts";
import * as session from "../session.ts";
import { MutationUncertain, PolicyError, StalePage } from "../types.ts";

import { BUDGET, FAILED, OK, print, STALE, UNCERTAIN } from "./context.ts";
import { attach, browserView, exploreActionsLeft, loggable, recordFindings, requireSession } from "./shared.ts";

/** Why `act` cannot run from the state's last outcome, as the exit code after saying so. null when it can. */
function rejectAct(state: session.State): number | null {
  if (state.outcome === agent.NEEDS_HUMAN) {
    print("REJECTED: a person is acting. When they are done: run --human-done");
    return FAILED;
  }
  if (state.outcome === agent.UNCERTAIN) {
    print("REJECTED: the last action may have happened. Run: webhand finish --status error");
    return UNCERTAIN;
  }
  if (exploreActionsLeft(state) === 0) {
    print("BUDGET EXHAUSTED for this exploring session. Run findings, then finish --status budget");
    return BUDGET;
  }
  if (agent.actionsIn(state.history, state.plan.attempt).length >= state.max_actions) {
    print("BUDGET EXHAUSTED for this attempt. Run replan or finish --status budget");
    return BUDGET;
  }
  return null;
}

/** The one operation Claude named, resolved against the page; or the exit code after saying why it is refused. */
function decideAct(args: Args, state: session.State): ReturnType<typeof resolve> | number {
  let decision: ReturnType<typeof resolve>;
  try {
    decision = resolve(state.page, args.operation, args.target);
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    print(`REJECTED: ${error.message}`);
    return FAILED;
  }
  if (decision.action === null) {
    print("REJECTED: act runs one operation. Use run, replan, or finish");
    return FAILED;
  }
  const rule = inForce(state);
  const refused = rule ? refusal(decision.action, rule) : null;
  if (refused) {
    print(`REJECTED: read-only session: ${refused}`);
    return FAILED;
  }
  if (decision.action.kind === "fill" && args.text === null) {
    print("REJECTED: TYPE_TEXT needs --text");
    return FAILED;
  }
  if (decision.action.kind === "upload") {
    const file = (state.plan.files ?? []).find((f: { label: string }) => f.label === args.file);
    if (!file) {
      print("REJECTED: UPLOAD_FILE needs --file with the label of one of the plan's files");
      return FAILED;
    }
    decision.text = file.value;
    return decision;
  }
  decision.text = decision.action.kind === "fill" ? args.text : null;
  return decision;
}

/** Runs the decision once. A stale page runs nothing; an uncertain result stops the run. */
async function performAct(state: session.State, decision: ReturnType<typeof resolve>): Promise<number> {
  const browser = await attach(state, null, browserView(state));
  const recorder = new Recorder(state.log);
  try {
    await execute(browser, state.page, decision, state.history, recorder, {
      decidedBy: "claude",
      attempt: state.plan.attempt,
      values: loggable(state.plan),
      onChange: (page) => {
        state.page = page;
        session.save(state);
        recordFindings(state, browser, recorder);
      },
    });
    if (state.outcome !== agent.ATTEMPT_BUDGET) {
      state.outcome = null; // Claude stepped in, so Jev may continue this attempt with run.
      session.save(state);
    }
    const downloads = state.history.at(-1)?.downloads as { name: string; bytes: number }[] | undefined;
    if (downloads?.length) {
      print(`DOWNLOADED: ${downloads.map((d) => `${d.name} (${d.bytes} bytes)`).join(", ")} in ${state.download_dir}`);
    }
    recordFindings(state, browser, recorder);
    print(render(state.page));
    return OK;
  } catch (error) {
    if (error instanceof StalePage) {
      state.page = await browser.observe();
      session.save(state);
      print(`STALE, nothing executed: ${error.message}\n${render(state.page)}`);
      return STALE;
    }
    if (error instanceof MutationUncertain) {
      state.outcome = agent.UNCERTAIN;
      session.save(state);
      print(`UNCERTAIN, do not repeat this action: ${error.message}. Run: webhand finish --status error`);
      return UNCERTAIN;
    }
    throw error;
  } finally {
    await browser.close();
    recorder.close();
  }
}

/** Claude overrides Jev for one operation. */
export async function commandAct(args: Args): Promise<number> {
  const state = requireSession();
  const rejected = rejectAct(state);
  if (rejected !== null) return rejected;
  const decision = decideAct(args, state);
  if (typeof decision === "number") return decision;
  state.decisions += 1;
  session.save(state);
  return performAct(state, decision);
}
