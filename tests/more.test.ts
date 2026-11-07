import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { loadTask } from "../research/tasks.ts";
import { Browser } from "../src/browser.ts";
import { collectScan } from "../src/collect.ts";
import { type Candidate, compareScan, NONE } from "../src/compare.ts";
import { Recorder } from "../src/metrics.ts";
import { loadMore, type MoreChooser } from "../src/more.ts";
import { buildMore, JevPolicy } from "../src/policies/jev.ts";
import { type Action, type ModelCall, MutationUncertain, type Page, type Plan, PolicyError } from "../src/types.ts";
import { ROOT, tmpPath } from "./helpers.ts";
import { ScriptedJev } from "./jev.ts";

let browser: Browser | null = null;

afterEach(async () => {
  await browser?.close();
  browser = null;
});

/** Chooses the element with Claude's label, as a stand-in for Jev, or always NONE. */
class Control implements MoreChooser {
  calls: ModelCall[] = [];
  asked = 0;
  readonly never: boolean;
  constructor(never = false) {
    this.never = never;
  }
  async more(_page: Page, _plan: Plan, control: string, items: Candidate[]) {
    this.asked += 1;
    if (this.never) return NONE;
    return items.find((item) => item.action.label === control)?.key ?? NONE;
  }
}

const plan = (goal: string): Plan => ({ goal, steps: [], values: [], attempt: 1 });

async function open(name: string) {
  const task = await loadTask(name);
  browser = await Browser.open(task.startUrl(ROOT));
  return { task, recorder: new Recorder(join(tmpPath(), "run.jsonl")) };
}

test("plan_pages: the comparison goes through every page, then back to the page of the cheapest", async () => {
  const { task, recorder } = await open("plan_pages");
  const b = browser as Browser;
  const more = loadMore(b, new Control(), plan(task.GOAL), "Next page", recorder, 1);
  const { compared, page } = await compareScan(b, new ScriptedJev(), plan(task.GOAL), "lowest", recorder, {
    loadMore: more,
  });
  recorder.close();
  expect(compared).toMatchObject({ stopped: "bottom", pages: 3 });
  expect(compared.best).toMatch(/^Choose Tuff — /);
  expect(page.url).toMatch(/\?page=3$/);
  const click = page.actions.find((a: Action) => a.kind === "click" && a.label === "Choose Tuff");
  await b.act(click, page);
  expect((await task.verify(b)).success).toBe(true);
});

test("collect_button: the collection presses Show more plans until all forty are shown", async () => {
  const { recorder } = await open("collect_button");
  const b = browser as Browser;
  const more = loadMore(b, new Control(), plan("g"), "Show more plans", recorder, 1);
  const { collected, page } = await collectScan(b, new ScriptedJev(), plan("g"), "less than €40", recorder, {
    loadMore: more,
  });
  recorder.close();
  expect(collected).toMatchObject({ matched: 4, seen: 40, pages: 3, stopped: "bottom" });
  expect(page.scroll.y).toBe(0);
});

test("without the control, the scan stops at the bottom with what it has", async () => {
  const { recorder } = await open("collect_button");
  const b = browser as Browser;
  const chooser = new Control(true);
  const more = loadMore(b, chooser, plan("g"), "Show more plans", recorder, 1);
  const { collected } = await collectScan(b, new ScriptedJev(), plan("g"), "less than €40", recorder, {
    loadMore: more,
  });
  recorder.close();
  expect(collected).toMatchObject({ seen: 10, pages: 0, stopped: "bottom" });
  expect(chooser.asked).toBe(1);
});

test("a control choice that is not offered presses nothing; an interrupted press is uncertain", async () => {
  const page = { url: "u", title: "t", text: "", actions: [], scroll: { y: 0, height: 0 }, h: 0 } as Page;
  const item = { kind: "click", label: "Next page", node: 1 } as Action;
  const fake = {
    observe: async () => page,
    fresh: async () => true,
    act: vi.fn(async () => {
      throw new MutationUncertain("click was interrupted");
    }),
    contexts: async () => ({}),
  };
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const pick = (key: string): MoreChooser => ({ calls: [], more: async () => key });
  await expect(
    loadMore(fake, pick("9"), plan("g"), "Next page", recorder, 1)({ ...page, actions: [item] }),
  ).rejects.toThrow(PolicyError);
  expect(fake.act).not.toHaveBeenCalled();
  await expect(
    loadMore(fake, pick("1"), plan("g"), "Next page", recorder, 1)({ ...page, actions: [item] }),
  ).rejects.toThrow(MutationUncertain);
  expect(fake.act).toHaveBeenCalledTimes(1);
  recorder.close();
});

test("the control question offers the elements in view and NONE, and gives Jev the page", async () => {
  const items = [
    { key: "1", action: { kind: "click", label: "Next page", node: 1 } as Action, context: "Page 1 of 4" },
  ];
  const question = buildMore("Next page", items).more as { criteria: Map<string, string> };
  expect([...question.criteria.keys()]).toEqual(["1", NONE]);
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const sent: { body: { state: { page?: unknown } } | null } = { body: null };
  const reply = { answers: { more: { choice: "1", confidence: 0.9, probabilities: { "1": 1, NONE: 0 } } } };
  const policy = new JevPolicy({
    fetch: async (_url, init) => {
      sent.body = JSON.parse(init.body);
      return { status: 200, json: async () => reply };
    },
  });
  const page = { url: "u", title: "t", text: "", actions: [], scroll: { y: 0, height: 0 }, h: 0 } as Page;
  expect(await policy.more(page, plan("g"), "Next page", items)).toBe("1");
  expect(sent.body?.state.page).toBeDefined();
  expect(policy.calls[0].purpose).toBe("more");
});
