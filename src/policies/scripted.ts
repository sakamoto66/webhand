/** Fixed steps from the task file. No API. It tests the harness, not an agent. */

import { quote } from "../format.ts";
import { type Decision, type HistoryEntry, type ModelCall, type Page, type Policy, PolicyError } from "../types.ts";
import { actionSpace, OPERATIONS, resolve } from "./base.ts";

export interface ScriptStep {
  operation: string;
  label?: string;
  text?: string;
}

/**
 * A step advances only once its action reaches the history.
 *
 * A stale page means nothing happened, so the same step is chosen again on the fresh page.
 * A step without a label is a control such as SCROLL_UP or WAIT.
 */
export class ScriptedPolicy implements Policy {
  name = "scripted";
  calls: ModelCall[] = [];
  private position = 0;
  private pending: number | null = null; // history length when the current step was chosen
  private readonly script: ScriptStep[];

  constructor(script: ScriptStep[]) {
    this.script = script;
  }

  config(): Record<string, unknown> {
    return { chooser: "scripted" };
  }

  async choose(page: Page, _plan: unknown, history: HistoryEntry[]): Promise<Decision> {
    if (this.pending !== null && history.length > this.pending) this.position += 1;
    this.pending = null;
    if (this.position >= this.script.length) return resolve(page, "DONE", null);
    const step = this.script[this.position];
    if (!Object.values(OPERATIONS).includes(step.operation)) {
      this.pending = history.length;
      return resolve(page, step.operation, null);
    }
    const kind = Object.entries(OPERATIONS).find(([, operation]) => operation === step.operation)?.[0];
    const [, targets, controls] = actionSpace(page.actions);
    for (const [target, action] of targets.get(step.operation) ?? []) {
      if (action.kind === kind && String(action.label).includes(step.label ?? "")) {
        this.pending = history.length;
        const decision = resolve(page, step.operation, target);
        decision.text = step.text ?? null;
        return decision;
      }
    }
    if (controls.has("SCROLL_DOWN")) return resolve(page, "SCROLL_DOWN", null);
    throw new PolicyError(`Scripted step not found: ${quote(step)}`);
  }
}
