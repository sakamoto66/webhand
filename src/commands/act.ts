import * as agent from "../agent.ts";
import { execute } from "../agent.ts";
import type { Args } from "../args.ts";
import { Recorder } from "../metrics.ts";
import { render } from "../output.ts";
import { resolve } from "../policies/base.ts";
import * as session from "../session.ts";
import { MutationUncertain, PolicyError, StalePage } from "../types.ts";

import { BUDGET, FAILED, OK, print, STALE, UNCERTAIN } from "./context.ts";
import { attach, browserView, requireSession } from "./shared.ts";

/** Claude overrides Jev for one operation. */
export async function commandAct(args: Args): Promise<number> {
  const state = requireSession();
  if (state.outcome === agent.NEEDS_HUMAN) {
    print("REJECTED: a person is acting. When they are done: run --human-done");
    return FAILED;
  }
  if (state.outcome === agent.UNCERTAIN) {
    print("REJECTED: the last action may have happened. Run: webhand finish --status error");
    return UNCERTAIN;
  }
  if (agent.actionsIn(state.history, state.plan.attempt).length >= state.max_actions) {
    print("BUDGET EXHAUSTED for this attempt. Run replan or finish --status budget");
    return BUDGET;
  }
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
  if (decision.action.kind === "fill" && args.text === null) {
    print("REJECTED: TYPE_TEXT needs --text");
    return FAILED;
  }
  decision.text = decision.action.kind === "fill" ? args.text : null;
  state.decisions += 1;
  session.save(state);
  const browser = await attach(state, null, browserView(state));
  const recorder = new Recorder(state.log);
  try {
    await execute(browser, state.page, decision, state.history, recorder, {
      decidedBy: "claude",
      attempt: state.plan.attempt,
      values: state.plan.values,
      onChange: (page) => {
        state.page = page;
        session.save(state);
      },
    });
    if (state.outcome !== agent.ATTEMPT_BUDGET) {
      state.outcome = null; // Claude stepped in, so Jev may continue this attempt with run.
      session.save(state);
    }
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
