/** Jev replaced for CLI tests: no paid API. */

import { join } from "node:path";
import { vi } from "vitest";
import { deps } from "../src/cli.ts";
import { actionSpace, modelState, resolve, valueChoices } from "../src/policies/base.ts";
import * as session from "../src/session.ts";
import { Decision, type HistoryEntry, type ModelCall, modelCall, type Page, type Plan } from "../src/types.ts";
import { tmpPath } from "./helpers.ts";

/** [operation, element label, value label]. The value label picks one of Claude's values; null: none fits. */
export type Move = [string, string | null, string | null];

/** Plays Jev: chooses from the observed page and records the plan and state it was given. */
export class ScriptedJev {
  static moves: Move[] = [];
  static plans: Plan[] = [];
  static states: Record<string, unknown>[] = [];
  name = "jev";
  calls: ModelCall[] = [];

  config() {
    return { chooser: "scripted-jev" };
  }

  async choose(page: Page, plan: Plan, history: HistoryEntry[]): Promise<Decision> {
    ScriptedJev.plans.push(structuredClone(plan));
    ScriptedJev.states.push(modelState(page, history, plan));
    this.calls.push(modelCall("typesafe", "jev", "choose", 1, 10, 1));
    const move = ScriptedJev.moves.shift();
    if (!move) throw new Error("ScriptedJev ran out of moves");
    const [operation, label, value] = move;
    if (label === null) return new Decision(operation, null, { confidence: 0.9 });
    const [, targets] = actionSpace(page.actions);
    const index = [...(targets.get(operation) ?? [])].find(([, a]) => String(a.label).includes(label))?.[0];
    const decision = resolve(page, operation, index);
    decision.confidence = 0.9;
    if (operation === "TYPE_TEXT" && value !== null) {
      decision.text = [...valueChoices(plan).values()].find((v) => v.label === value)?.value ?? null;
    }
    return decision;
  }
}

/** Isolates a CLI test: its own home and log, a fake key, and ScriptedJev. Returns the log path. */
export function isolate(): { log: string; cleanup: () => Promise<void> } {
  const dir = tmpPath();
  vi.stubEnv("WEBHAND_HOME", join(dir, "home"));
  const log = join(dir, "run.jsonl");
  vi.stubEnv("WEBHAND_LOG", log);
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  deps.policy = () => new ScriptedJev();
  ScriptedJev.moves = [];
  ScriptedJev.plans = [];
  ScriptedJev.states = [];
  return {
    log,
    cleanup: async () => {
      const state = session.load();
      if (state) {
        await session.stopChrome(state);
        session.clear();
      }
    },
  };
}
