/** Jev replaced for CLI tests: no paid API. */

import { join } from "node:path";
import { vi } from "vitest";
import { deps } from "../src/commands/context.ts";
import { Decision, type HistoryEntry, type ModelCall, modelCall, type Page, type Plan } from "../src/core/types.ts";
import { actionSpace, modelState, resolve, valueChoices } from "../src/policies/base.ts";
import type { Row } from "../src/scans/collect.ts";
import { type Best, type Candidate, KEEP, NONE } from "../src/scans/compare.ts";
import type { LinkView } from "../src/scans/drilldown.ts";
import * as session from "../src/storage/session.ts";
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

  /** Compares by the price in each item's text, the lowest winning. */
  async compare(_page: Page, _plan: Plan, _criterion: string, best: Best | null, items: Candidate[]): Promise<string> {
    this.calls.push(modelCall("typesafe", "jev", "compare", 1, 10, 1));
    const price = (text: string) => Number(/€(\d+)/.exec(text)?.[1] ?? Number.POSITIVE_INFINITY);
    let choice = best ? KEEP : NONE;
    let lowest = best ? price(best.context) : Number.POSITIVE_INFINITY;
    for (const item of items) {
      if (price(item.context) < lowest) [choice, lowest] = [item.key, price(item.context)];
    }
    return choice;
  }

  /** Finds Claude's control by its label. */
  async more(_page: Page, _plan: Plan, control: string, items: Candidate[]): Promise<string> {
    this.calls.push(modelCall("typesafe", "jev", "more", 1, 10, 1));
    const found = items.find((item) => item.action.label.toLowerCase() === control.toLowerCase());
    return found ? found.key : NONE;
  }

  /** Collects the 200 GB rows under the price in the criterion, such as "less than €40". */
  async collect(_page: Page, _plan: Plan, criterion: string, rows: Row[]): Promise<Set<string>> {
    this.calls.push(modelCall("typesafe", "jev", "collect", 1, 10, 1));
    const limit = Number(/€(\d+)/.exec(criterion)?.[1] ?? 0);
    const price = (text: string) => Number(/€(\d+)/.exec(text)?.[1] ?? Number.POSITIVE_INFINITY);
    return new Set(rows.filter((r) => r.text.includes("200 GB") && price(r.text) < limit).map((r) => r.key));
  }

  /** Takes each row's first link as its detail link. */
  async detailLink(_row: string, links: LinkView[]): Promise<{ key: string; noul: number }> {
    this.calls.push(modelCall("typesafe", "jev", "detail_link", 1, 10, 1));
    return { key: links[0].key, noul: 0.95 };
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
