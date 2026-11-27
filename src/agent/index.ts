/**
 * Jev's loop toward Claude's goal: observe, choose, execute. It stops; it never claims success.
 * The loop returns to Claude only when it cannot continue on its own. The task's verify() decides success.
 */

import type { Recorder } from "../core/metrics.ts";
import {
  type Action,
  type Decision,
  type HistoryEntry,
  MutationUncertain,
  type Page,
  type Plan,
  type Policy,
  PolicyError,
  StalePage,
} from "../core/types.ts";
import { CLAIM_MET, CLAIM_NOT_MET, RECOVERY_ESCALATE, RECOVERY_STRATEGIES } from "../policies/prompts.ts";
import { scroll } from "../scans/list-scanner.ts";
import type { SiteMemory } from "../storage/memory.ts";
import {
  captureScreenshot,
  checkPage,
  execute,
  intoView,
  noteNotVisible,
  noteRefused,
  type OnChange,
} from "./execute.ts";
import { actionsIn, executed, looping, MAX_UNCHANGED_WAITS, stopReason, unseenParts, waitedOut } from "./guards.ts";
import {
  type Actor,
  type AgentResult,
  ATTEMPT_BUDGET,
  BLOCKED,
  Budget,
  CHECKED_OUTCOMES,
  ESCALATE,
  GOAL_REPORTED,
  JEV_FAILED,
  NEEDS_HUMAN,
  NEEDS_VALUE,
  READ_ONLY,
  STUCK,
  UNCERTAIN,
} from "./outcomes.ts";
import { type ReadOnly, refusal } from "./readonly.ts";

export {
  type Actor,
  type AgentResult,
  ATTEMPT_BUDGET,
  actionsIn,
  BLOCKED,
  Budget,
  CHECKED_OUTCOMES,
  captureScreenshot,
  checkPage,
  ESCALATE,
  execute,
  executed,
  GOAL_REPORTED,
  JEV_FAILED,
  looping,
  MAX_UNCHANGED_WAITS,
  NEEDS_HUMAN,
  NEEDS_VALUE,
  READ_ONLY,
  STUCK,
  UNCERTAIN,
  unseenParts,
  waitedOut,
};

const TERMINAL_OUTCOMES: Record<string, string> = {
  DONE: GOAL_REPORTED,
  NEEDS_HUMAN,
  ESCALATE,
};

/** Max Jev self-verification rejections per attempt before letting GOAL_REPORTED reach Claude. */
const MAX_SELF_VERIFY_REJECTIONS = 2;
/** Max non-destructive tactical recoveries per attempt before stopping as STUCK. */
const MAX_RECOVERIES = 2;

/** Runs one attempt until an outcome above. history is extended in place. */
export async function runAgent(
  browser: Actor,
  policy: Policy,
  plan: Plan,
  recorder: Recorder,
  budget: Budget = new Budget(),
  options: {
    history?: HistoryEntry[];
    page?: Page | null;
    decisions?: number;
    onChange?: OnChange;
    onDecision?: (count: number) => void;
    memory?: SiteMemory;
    /** A read-only session: an action it refuses ends the attempt as READ_ONLY, before anything runs. */
    readOnly?: ReadOnly | null;
  } = {},
): Promise<AgentResult> {
  const attempt = plan.attempt ?? 1;
  const history = options.history ?? [];
  const onChange = options.onChange ?? (() => {});
  const onDecision = options.onDecision ?? (() => {});
  let decisions = options.decisions ?? 0;
  let verifyRejections = 0;
  let recoveries = 0;
  const tacticalHints: string[] = [];
  const started = performance.now();
  let page = options.page || (await browser.observe());

  const activePlan = (): Plan =>
    tacticalHints.length ? { ...plan, instructions: [...(plan.instructions ?? []), ...tacticalHints] } : plan;

  const flushCalls = () => {
    for (const call of policy.calls) recorder.call(call);
    policy.calls.length = 0;
  };

  const finish = (outcome: string, detail: string | null = null, extra: Partial<AgentResult> = {}): AgentResult => ({
    outcome,
    detail,
    page,
    actions: actionsIn(history, attempt).length,
    decisions,
    elapsed_ms: Math.round(performance.now() - started),
    ...extra,
  });

  while (true) {
    const stop = stopReason(plan, history, page, attempt, budget, decisions);
    if (stop) {
      const [stopOutcome, stopDetail] = stop;
      const canRecover =
        stopOutcome === STUCK &&
        Boolean(plan.recover) &&
        Boolean(policy.recover) &&
        recoveries < MAX_RECOVERIES &&
        !stopDetail.includes("cannot see");
      if (canRecover && policy.recover) {
        try {
          const picked = await policy.recover(page, activePlan(), history);
          flushCalls();
          recorder.event("tactical_recovery", {
            attempt,
            strategy: picked.strategy,
            confidence: picked.confidence,
          });
          if (picked.strategy !== RECOVERY_ESCALATE) {
            recoveries += 1;
            if (picked.strategy === "SCROLL_TO_TOP" && (page.scroll?.y ?? 0) > 0) {
              await browser.act(scroll(-page.scroll.y), page);
              page = await browser.observe();
            }
            const guidance = RECOVERY_STRATEGIES[picked.strategy] ?? picked.strategy;
            tacticalHints.push(`Tactical recovery (${picked.strategy}): ${guidance}`);
            history.push({
              step: history.length + 1,
              attempt,
              kind: "recovery",
              operation: "RECOVERY",
              action: `Tactical recovery: ${picked.strategy}`,
              text: null,
              url: page.url,
              page_changed: true,
            });
            onChange(page);
            continue;
          }
        } catch (error) {
          flushCalls();
          if (error instanceof PolicyError) {
            return finish(JEV_FAILED, error.message, error.diagnostic ? { jev: error.diagnostic } : {});
          }
          if (error instanceof MutationUncertain) {
            return finish(UNCERTAIN, `mutation uncertain: ${error.message}`);
          }
          // Non-fatal recovery failure falls through to normal STUCK escalation.
        }
      }
      return finish(stopOutcome, stopDetail);
    }
    let decision: Decision | null = null;
    const executedBefore = history.length;
    try {
      if (!(await browser.fresh(page))) page = await browser.observe();
      decisions += 1;
      onDecision(decisions);
      const known = options.memory?.hints(page.url) ?? [];
      if (known.length) recorder.event("known_offered", { attempt, count: known.length });
      decision = await policy.choose(known.length ? { ...page, known } : page, activePlan(), history);
      flushCalls();
      if (decision.operation === "NOT_VISIBLE") {
        await noteNotVisible(browser, recorder, history, page, decision, attempt);
        page = await browser.observe();
        onChange(page);
        continue;
      }
      if (decision.action === null) {
        if (!(await browser.fresh(page))) continue;
        if (
          decision.operation === "DONE" &&
          plan.expects?.length &&
          policy.verifyClaims &&
          verifyRejections < MAX_SELF_VERIFY_REJECTIONS
        ) {
          const verdicts = await policy.verifyClaims(page, activePlan(), plan.expects);
          flushCalls();
          const met = [...verdicts.entries()].filter(([, v]) => v === CLAIM_MET).map(([c]) => c);
          const unmet = [...verdicts.entries()].filter(([, v]) => v === CLAIM_NOT_MET).map(([c]) => c);
          const unknown = [...verdicts.entries()]
            .filter(([, v]) => v !== CLAIM_MET && v !== CLAIM_NOT_MET)
            .map(([c]) => c);
          recorder.event("self_verify", {
            attempt,
            met: met.length,
            unmet: unmet.length,
            unknown: unknown.length,
          });
          if (unmet.length > 0) {
            verifyRejections += 1;
            tacticalHints.push(
              `Self-verification rejected premature DONE. Complete these unmet expectations before choosing DONE: ${unmet.join("; ")}`,
            );
            history.push({
              step: history.length + 1,
              attempt,
              kind: "verify",
              operation: "SELF_VERIFY",
              action: `Unmet expectations: ${unmet.join("; ")}`,
              text: null,
              url: page.url,
              page_changed: true,
            });
            onChange(page);
            continue;
          }
        }
        return finish(TERMINAL_OUTCOMES[decision.operation] ?? BLOCKED, `Jev chose ${decision.operation}`);
      }
      if ((decision.action.kind === "fill" || decision.action.kind === "upload") && decision.text === null) {
        const field: Record<string, unknown> = {};
        for (const key of ["label", "role", "value"]) field[key] = decision.action[key] ?? null;
        for (const key of ["placeholder", "pattern"]) {
          if (decision.action[key]) field[key] = decision.action[key];
        }
        const what = decision.action.kind === "upload" ? "file" : "value";
        return finish(NEEDS_VALUE, `no ${what} from the plan fits this field`, { field });
      }
      const refused = options.readOnly ? refusal(decision.action, options.readOnly) : null;
      if (refused) {
        recorder.event("read_only_refused", { attempt, kind: decision.action.kind, target: decision.action.label });
        return finish(READ_ONLY, `read-only: ${refused}`);
      }
      if (decision.action.offscreen) ({ page, decision } = await intoView(browser, page, decision, recorder, attempt));
      page = await execute(browser, page, decision, history, recorder, {
        decidedBy: policy.name,
        attempt,
        onChange,
        values: [...plan.values, ...(plan.files ?? [])],
        memory: options.memory,
      });
    } catch (error) {
      if (error instanceof StalePage) {
        const observed = page;
        page = await browser.observe();
        // Only a refused action is noted. A step that ran is already in history, whatever failed after it.
        if (decision !== null && decision.action !== null && history.length === executedBefore) {
          noteRefused(recorder, history, decision as Decision & { action: Action }, error, observed, page, attempt);
        }
        onChange(page);
      } else if (error instanceof PolicyError) {
        return finish(JEV_FAILED, error.message, error.diagnostic ? { jev: error.diagnostic } : {});
      } else if (error instanceof MutationUncertain) {
        return finish(UNCERTAIN, `mutation uncertain: ${error.message}`);
      } else {
        throw error;
      }
    } finally {
      flushCalls();
    }
  }
}
