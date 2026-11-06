import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { loadTask } from "../research/tasks.ts";
import { Browser } from "../src/browser.ts";
import { type Collector, collectScan, MATCH, NO, type Row } from "../src/collect.ts";
import { Recorder } from "../src/metrics.ts";
import { buildCollect, JevPolicy } from "../src/policies/jev.ts";
import { type Action, type ModelCall, type Plan, PolicyError } from "../src/types.ts";
import { ROOT, tmpPath } from "./helpers.ts";

let browser: Browser | null = null;

afterEach(async () => {
  await browser?.close();
  browser = null;
});

const LIMITS: Record<string, number> = { collect_more: 40, collect_virtual: 25 };

/** Collects the 200 GB rows under the task's price, as a stand-in for Jev. Records what it was asked. */
class Matching implements Collector {
  calls: ModelCall[] = [];
  asked: number[] = [];
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  async collect(_page: unknown, _plan: Plan, _criterion: string, rows: Row[]) {
    this.asked.push(rows.length);
    const price = (text: string) => Number(/€(\d+)/.exec(text)?.[1] ?? Number.POSITIVE_INFINITY);
    return new Set(rows.filter((r) => r.text.includes("200 GB") && price(r.text) < this.limit).map((r) => r.key));
  }
}

const plan = (goal: string): Plan => ({ goal, steps: [], values: [], attempt: 1 });

async function scan(name: string) {
  const task = await loadTask(name);
  browser = await Browser.open(task.startUrl(ROOT));
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const collector = new Matching(LIMITS[name]);
  const result = await collectScan(browser, collector, plan(task.GOAL), "200 GB and cheap", recorder);
  recorder.close();
  return { task, result, collector };
}

test.each(Object.keys(LIMITS))(
  "%s: the scan sees every plan once, keeps exactly the matching ones, and types nothing",
  async (name) => {
    const { task, result, collector } = await scan(name);
    const expected = await (browser as Browser).evaluate(
      `PLANS.filter((p) => p[1] === "200 GB" && p[2] < ${LIMITS[name]}).map((p) => p[0])`,
    );
    const all = (await (browser as Browser).evaluate("PLANS.length")) as number;
    expect(result.collected).toMatchObject({ stopped: "bottom", seen: all, matched: (expected as string[]).length });
    expect(result.collected.items.map((item) => item.split(" ")[0]).sort()).toEqual((expected as string[]).sort());
    expect(collector.asked.reduce((a, b) => a + b, 0)).toBe(all);
    expect((await task.verify(browser as Browser)).success).toBe(false);
    expect(result.page.scroll.y).toBe(0);
    expect(result.page.actions.some((a: Action) => a.kind === "type" || a.label === "Submit")).toBe(true);
  },
);

test("collect_virtual: no screen holds the whole list, so items are kept as text", async () => {
  const { collector } = await scan("collect_virtual");
  expect(Math.max(...collector.asked)).toBeLessThan(200);
});

test("the page is scrolled back to where it was before the scan", async () => {
  const task = await loadTask("collect_more");
  browser = await Browser.open(task.startUrl(ROOT));
  await browser.evaluate("window.scrollTo(0, 400)");
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const result = await collectScan(browser, new Matching(40), plan(task.GOAL), "c", recorder);
  recorder.close();
  expect(result.page.scroll.y).toBe(400);
});

test("rows() reads table rows in view and leaves out header rows", async () => {
  const task = await loadTask("collect_more");
  browser = await Browser.open(task.startUrl(ROOT));
  await browser.evaluate("document.getElementById('plans').scrollIntoView()");
  const rows = await browser.rows();
  expect(rows.length).toBeGreaterThan(0);
  expect(rows).not.toContain("Plan Storage Monthly price");
  expect(rows.every((row) => /^\S+ \d+ GB €\d+$/.test(row))).toBe(true);
});

test("the collection asks one MATCH-or-NO question per item", () => {
  const questions = buildCollect("under €40", [
    { key: "1", text: "Tuff 200 GB €11" },
    { key: "2", text: "Shale 200 GB €95" },
  ]) as Record<string, { criteria: Map<string, string>; instructions: { item: string } }>;
  expect(Object.keys(questions)).toEqual(["item_1", "item_2"]);
  expect([...questions.item_1.criteria.keys()]).toEqual([MATCH, NO]);
  expect(questions.item_2.instructions.item).toBe("Shale 200 GB €95");
});

test("Jev's collection answers must each be MATCH or NO", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const answer = (choice: string) => ({ choice, confidence: 0.9, probabilities: { MATCH: 1, NO: 0 } });
  let reply: unknown = {
    answers: { item_1: answer(MATCH), item_2: { ...answer(NO), probabilities: { MATCH: 0, NO: 1 } } },
  };
  const policy = new JevPolicy({ fetch: async () => ({ status: 200, json: async () => reply }) });
  const rows = [
    { key: "1", text: "Tuff 200 GB €11" },
    { key: "2", text: "Shale 200 GB €95" },
  ];
  const page = { url: "u", title: "t", text: "", actions: [], scroll: { y: 0, height: 0 }, h: 0 };
  expect([...(await policy.collect(page, plan("g"), "c", rows))]).toEqual(["1"]);
  expect(policy.calls[0].purpose).toBe("collect");
  reply = { answers: { item_1: answer(MATCH) } };
  await expect(policy.collect(page, plan("g"), "c", rows)).rejects.toThrow(PolicyError);
});
