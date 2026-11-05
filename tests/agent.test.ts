/** Offline loop behaviour with a fake browser. No model or Chrome. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Actor, Budget, runAgent } from "../src/agent.ts";
import { Recorder } from "../src/metrics.ts";
import {
  Decision,
  type HistoryEntry,
  type ModelCall,
  MutationUncertain,
  modelCall,
  type Page,
  type Plan,
  PolicyError,
  StalePage,
} from "../src/types.ts";
import { readEvents, tmpPath } from "./helpers.ts";

const FILL = { id: "e1", kind: "fill", label: "Destination", node: 1, value: "" };
const CLICK = { id: "e2", kind: "click", label: "Go", node: 2 };

const page = (marker = "a"): Page => ({ url: "u", title: "t", text: "x", actions: [FILL, CLICK], marker });

class FakeBrowser implements Actor {
  actErrors: Error[];
  acts: [string, string | null][] = [];
  count = 0;
  observes = 0;

  constructor(actErrors: Error[] = []) {
    this.actErrors = [...actErrors];
  }

  async observe(): Promise<Page> {
    this.observes += 1;
    this.count += 1;
    return page(String(this.count));
  }

  async fresh(): Promise<boolean> {
    return true;
  }

  async act(action: Page, _page: Page, text: string | null = null): Promise<void> {
    this.acts.push([action.id, text]);
    const error = this.actErrors.shift();
    if (error) throw error;
  }
}

class FakePolicy {
  name = "jev";
  calls: ModelCall[] = [];
  decisions: (Decision | Error)[];

  constructor(decisions: (Decision | Error)[]) {
    this.decisions = [...decisions];
  }

  config() {
    return {};
  }

  async choose(): Promise<Decision> {
    this.calls.push(modelCall("p", "m", "choose", 1));
    const result = this.decisions.shift();
    if (result instanceof Error) throw result;
    if (!result) throw new Error("FakePolicy ran out of decisions");
    return result;
  }
}

const PLAN: Plan = { goal: "g", steps: [], values: [{ label: "Destination", value: "Lisbon" }] };

let recorder: Recorder;

beforeEach(() => {
  recorder = new Recorder(join(tmpPath(), "run.jsonl"));
});

afterEach(() => {
  recorder.close();
});

const run = (browser: Actor, decisions: (Decision | Error)[], budget?: Budget, history?: HistoryEntry[]) =>
  runAgent(browser, new FakePolicy(decisions), PLAN, recorder, budget, { history });

test("DONE is reported without claiming success", async () => {
  const result = await run(new FakeBrowser(), [new Decision("DONE")]);
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect("verified" in result).toBe(false);
});

test("NEEDS_HUMAN and BLOCKED return to Claude", async () => {
  expect((await run(new FakeBrowser(), [new Decision("NEEDS_HUMAN")])).outcome).toBe("NEEDS_HUMAN");
  expect((await run(new FakeBrowser(), [new Decision("BLOCKED")])).outcome).toBe("BLOCKED");
});

test("a stale page chooses again", async () => {
  const browser = new FakeBrowser([new StalePage("moved")]);
  const result = await run(browser, [new Decision("CLICK", CLICK), new Decision("CLICK", CLICK), new Decision("DONE")]);
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(result.actions).toBe(1);
  expect(result.decisions).toBe(3);
});

test("a refused stale choice is noted without counting as an action", async () => {
  const history: HistoryEntry[] = [];
  const result = await run(
    new FakeBrowser([new StalePage("moved")]),
    [new Decision("CLICK", CLICK), new Decision("DONE")],
    undefined,
    history,
  );
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(result.actions).toBe(0);
  expect(history[0].operation).toBe("STALE");
  expect(history[0].action).toContain("did not run: moved");
  expect(history[0].page_changed).toBe(true); // The page moved on, so this is not being stuck.
  const stale = readEvents(recorder.path)
    .filter((e) => e.type === "stale")
    .map((e) => [e.wanted, e.target, e.reason]);
  expect(stale).toEqual([["CLICK", "Go", "moved"]]);
});

test("a target refused on an unchanged page is stuck after three tries", async () => {
  class Covered extends FakeBrowser {
    override async observe() {
      return page("same");
    }
  }
  const browser = new Covered(Array.from({ length: 5 }, () => new StalePage("Target changed or is covered")));
  const result = await run(
    browser,
    Array.from({ length: 5 }, () => new Decision("CLICK", CLICK)),
  );
  expect(result.outcome).toBe("STUCK");
  expect(result.decisions).toBe(3);
  expect(result.actions).toBe(0);
});

test("a stale observation after an action ran is not noted as refused", async () => {
  class SlowToSettle extends FakeBrowser {
    override async observe() {
      if (this.acts.length && this.observes === 1) {
        this.observes += 1;
        throw new StalePage("Page did not settle");
      }
      return super.observe();
    }
  }
  const history: HistoryEntry[] = [];
  const result = await run(
    new SlowToSettle(),
    [new Decision("CLICK", CLICK), new Decision("DONE")],
    undefined,
    history,
  );
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(history.map((h) => h.operation)).toEqual(["CLICK"]);
});

test("an uncertain mutation stops and is never retried", async () => {
  const browser = new FakeBrowser([new MutationUncertain("interrupted")]);
  const result = await run(browser, [new Decision("CLICK", CLICK), new Decision("CLICK", CLICK)]);
  expect(result.outcome).toBe("UNCERTAIN");
  expect(browser.acts).toHaveLength(1);
});

test("rejected model output is logged and executes nothing", async () => {
  const browser = new FakeBrowser();
  const result = await run(browser, [new PolicyError("invalid")]);
  expect(result.outcome).toBe("JEV_FAILED");
  expect(browser.acts).toEqual([]);
  expect(recorder.calls).toHaveLength(1);
});

test("the budget stops the attempt", async () => {
  const wait = new Decision("WAIT", { id: "wait", kind: "wait", label: "Wait" });
  const result = await run(new FakeBrowser(), Array(5).fill(wait), new Budget(2));
  expect(result.outcome).toBe("ATTEMPT_BUDGET");
  expect(result.actions).toBe(2);
});

test("three unchanged pages are stuck", async () => {
  class Static extends FakeBrowser {
    override async observe() {
      return page("same");
    }
  }
  const result = await run(new Static(), Array(3).fill(new Decision("CLICK", CLICK)));
  expect(result.outcome).toBe("STUCK");
});

test("a value chosen by Jev is typed and a missing one types nothing", async () => {
  const browser = new FakeBrowser();
  const result = await run(browser, [
    new Decision("TYPE_TEXT", FILL, { text: "Lisbon" }),
    new Decision("TYPE_TEXT", FILL),
  ]);
  expect(browser.acts).toEqual([["e1", "Lisbon"]]);
  expect(result.outcome).toBe("NEEDS_VALUE");
  expect(result.field?.label).toBe("Destination");
});

test("the run log names the value and region, never the typed text", async () => {
  const browser = new FakeBrowser();
  const at = { ...FILL, region: "main/form:Search" };
  const start = { ...page(), url: "https://x.test/s?q=secret#a=b" };
  await runAgent(
    browser,
    new FakePolicy([new Decision("TYPE_TEXT", at, { text: "Lisbon" }), new Decision("DONE")]),
    PLAN,
    recorder,
    undefined,
    { page: start },
  );
  const step = readEvents(recorder.path).find((e) => e.type === "step");
  expect(step).toMatchObject({ value: "Destination", text_chars: 6, region: "main/form:Search" });
  expect(step.url).toBe("https://x.test/s?q=%3Credacted%3E#%3Credacted%3E");
  expect(JSON.stringify(readEvents(recorder.path))).not.toContain("Lisbon");
  expect(readEvents(recorder.path).filter((e) => e.type === "page")).toHaveLength(1);
});

test("history is extended in place with the attempt", async () => {
  const history: HistoryEntry[] = Array.from({ length: 3 }, () => ({ attempt: 1, kind: "click", page_changed: false }));
  const result = await runAgent(
    new FakeBrowser(),
    new FakePolicy([new Decision("CLICK", CLICK), new Decision("DONE")]),
    { ...PLAN, attempt: 2 },
    recorder,
    undefined,
    { history },
  );
  expect(result.outcome).toBe("GOAL_REPORTED"); // Attempt 1 being stuck does not stop attempt 2.
  expect(history.at(-1)?.attempt).toBe(2);
});

test("a target Jev cannot see runs nothing and is noted", async () => {
  const browser = new FakeBrowser();
  const missing = new Decision("NOT_VISIBLE", null, { wanted: "CLICK" });
  const history: HistoryEntry[] = [];
  const result = await run(browser, [missing, new Decision("CLICK", CLICK), new Decision("DONE")], undefined, history);
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(browser.acts).toEqual([["e2", null]]);
  expect(history[0].kind).toBe("missing");
  expect(history[0].page_changed).toBe(false);
  expect(result.actions).toBe(1); // Not counted against the budget.
});

test("three targets Jev cannot see are stuck", async () => {
  const missing = new Decision("NOT_VISIBLE", null, { wanted: "CLICK" });
  const result = await run(new FakeBrowser(), [missing, missing, missing]);
  expect(result.outcome).toBe("STUCK");
});

class ShootingBrowser extends FakeBrowser {
  shots = 0;
  fail = false;

  async screenshot(): Promise<Buffer> {
    this.shots += 1;
    if (this.fail) throw new Error("capture failed");
    return Buffer.from(`png${this.shots}`);
  }
}

test("screenshots are taken only when WEBHAND_SCREENSHOTS=1", async () => {
  const browser = new ShootingBrowser();
  await run(browser, [new Decision("CLICK", CLICK), new Decision("DONE")]);
  expect(browser.shots).toBe(0);
  expect(readEvents(recorder.path).some((e) => e.type === "screenshot")).toBe(false);
});

test("each action is followed by a screenshot beside the log", async () => {
  vi.stubEnv("WEBHAND_SCREENSHOTS", "1");
  const browser = new ShootingBrowser();
  await run(browser, [new Decision("CLICK", CLICK), new Decision("CLICK", CLICK), new Decision("DONE")]);
  const shots = readEvents(recorder.path).filter((e) => e.type === "screenshot");
  expect(shots.map((e) => [e.step, e.attempt, e.after, e.file])).toEqual([
    [1, 1, "action", join("run-screenshots", "step-0001-attempt-1.png")],
    [2, 1, "action", join("run-screenshots", "step-0002-attempt-1.png")],
  ]);
  expect(readFileSync(join(dirname(recorder.path), shots[1].file), "utf8")).toBe("png2");
});

test("a failed screenshot is logged and the run goes on", async () => {
  vi.stubEnv("WEBHAND_SCREENSHOTS", "1");
  const browser = new ShootingBrowser();
  browser.fail = true;
  const result = await run(browser, [new Decision("CLICK", CLICK), new Decision("DONE")]);
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(result.actions).toBe(1);
  const failed = readEvents(recorder.path).filter((e) => e.type === "screenshot_failed");
  expect(failed.map((e) => [e.step, e.error])).toEqual([[1, "capture failed"]]);
});

test("maskUrls hides query values in any URL inside a message", async () => {
  const { maskUrls } = await import("../src/metrics.ts");
  expect(maskUrls('navigating to "https://a.example/p?id=7&k=v", waiting')).toBe(
    'navigating to "https://a.example/p?id=%3Credacted%3E&k=%3Credacted%3E", waiting',
  );
});
