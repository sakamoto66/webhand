import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { loadTask } from "../../research/tasks.ts";
import { Browser } from "../../src/browser/index.ts";
import { Recorder } from "../../src/core/metrics.ts";
import { type Action, type ModelCall, type Plan, PolicyError } from "../../src/core/types.ts";
import { JevPolicy } from "../../src/policies/jev.ts";
import { buildCompare } from "../../src/policies/jev-questions.ts";
import { type Best, type Candidate, type Comparer, compareScan, KEEP, NONE } from "../../src/scans/compare.ts";
import { ROOT, tmpPath } from "../helpers.ts";

let browser: Browser | null = null;

afterEach(async () => {
  await browser?.close();
  browser = null;
});

const price = (text: string) => {
  const found = /€(\d+)/.exec(text);
  return found ? Number(found[1]) : null;
};

/** Compares by the price in each item's text, as a stand-in for Jev. Records what it was offered. */
class Cheapest implements Comparer {
  calls: ModelCall[] = [];
  offered: number[] = [];
  async compare(_page: unknown, _plan: Plan, _criterion: string, best: Best | null, items: Candidate[]) {
    this.offered.push(items.length);
    let choice = best ? KEEP : NONE;
    let lowest = best ? (price(best.context) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
    for (const item of items) {
      const value = price(item.context);
      if (value !== null && value < lowest) [choice, lowest] = [item.key, value];
    }
    return choice;
  }
}

const plan = (goal: string): Plan => ({ goal, steps: [], values: [], attempt: 1 });

async function scan(name: string, maxScrolls?: number) {
  const task = await loadTask(name);
  browser = await Browser.open(task.startUrl(ROOT));
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const comparer = new Cheapest();
  const result = await compareScan(browser, comparer, plan(task.GOAL), "lowest monthly price", recorder, {
    maxScrolls,
  });
  recorder.close();
  return { task, result, comparer };
}

test.each(["plan_lowest", "plan_more", "plan_many", "plan_virtual"])(
  "%s: the scan finds the cheapest plan, clicks nothing, and leaves it ready to click",
  async (name) => {
    const { task, result } = await scan(name);
    const expected = (await (browser as Browser)
      .evaluate("PLANS.reduce((b, p) => (b === null || p[2] < b[2] ? p : b), null)[0]")
      .catch(() => null)) as string | null;
    const cheapest = expected ?? "Flax"; // plan_lowest has no PLANS list.
    expect(result.compared.stopped).toBe("bottom");
    expect(result.compared.rounds).toBeLessThanOrEqual(20);
    expect(result.compared.best).toMatch(new RegExp(`^Choose ${cheapest} — `));
    expect(await (browser as Browser).evaluate("document.body.dataset.chosen ?? null")).toBe(null);
    const click = result.page.actions.find((a: Action) => a.kind === "click" && a.label === `Choose ${cheapest}`);
    expect(click).toBeDefined();
    await (browser as Browser).act(click, result.page);
    expect((await task.verify(browser as Browser)).success).toBe(true);
  },
);

test("plan_more: the scan waits at the bottom until all forty plans have loaded", async () => {
  await scan("plan_more");
  expect(await (browser as Browser).evaluate("document.querySelectorAll('#plans tr').length - 1")).toBe(40);
});

test("plan_virtual: no observation holds the whole list, so the best is kept as text", async () => {
  const { comparer } = await scan("plan_virtual");
  expect(Math.max(...comparer.offered)).toBeLessThan(200);
});

test("the scan stops at its scroll limit", async () => {
  const { result } = await scan("plan_many", 2);
  expect(result.compared).toMatchObject({ rounds: 2, stopped: "limit" });
});

test("the comparison question offers KEEP only with a best so far, and NONE only without one", () => {
  const action = { kind: "click", label: "Choose Oak", node: 1 };
  const items = [{ key: "1", action, context: "Oak 50 GB €73 Choose Oak" }];
  const first = buildCompare(plan("g"), "lowest price", null, items).compare as { criteria: Map<string, string> };
  expect([...first.criteria.keys()]).toEqual(["1", NONE]);
  expect(first.criteria.get("1")).toBe("[1] Choose Oak — Oak 50 GB €73 Choose Oak");
  const best = { label: "Choose Elm", context: "Elm 5 GB €20 Choose Elm", y: 0, round: 0 };
  const later = buildCompare(plan("g"), "lowest price", best, items).compare as { criteria: Map<string, string> };
  expect([...later.criteria.keys()]).toEqual(["1", KEEP]);
  expect(later.criteria.get(KEEP)).toBe("Keep the current best: Choose Elm — Elm 5 GB €20 Choose Elm");
});

test("Jev's comparison answer must be one of the offered keys", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const answer = (choice: string) => ({
    answers: {
      compare: {
        choice,
        confidence: 0.9,
        probabilities: { "1": choice === "1" ? 1 : 0, NONE: choice === "1" ? 0 : 1 },
      },
    },
  });
  let reply: unknown = answer("1");
  const policy = new JevPolicy({ fetch: async () => ({ status: 200, json: async () => reply }) });
  const items = [{ key: "1", action: { kind: "click", label: "Choose Oak", node: 1 }, context: "" }];
  const page = { url: "u", title: "t", text: "", actions: [], scroll: { y: 0, height: 0 }, h: 0 };
  expect(await policy.compare(page, plan("g"), "c", null, items)).toBe("1");
  expect(policy.calls[0].purpose).toBe("compare");
  reply = { answers: { compare: { choice: "KEEP", confidence: 1, probabilities: { "1": 0, KEEP: 1 } } } };
  await expect(policy.compare(page, plan("g"), "c", null, items)).rejects.toThrow(PolicyError);
});
