/** Real headless Chrome on the local fixtures. No model calls. */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadTask } from "../../research/tasks.ts";
import { Budget, runAgent } from "../../src/agent/index.ts";
import { Browser, type ViewChoice } from "../../src/browser/index.ts";
import { toJson } from "../../src/core/format.ts";
import { Recorder } from "../../src/core/metrics.ts";
import type { Action, HistoryEntry } from "../../src/core/types.ts";
import { actionSpace, modelState, valueChoices } from "../../src/policies/base.ts";
import { type Fetch, JevPolicy } from "../../src/policies/jev.ts";
import { estimateTokens } from "../../src/policies/jev-fit.ts";
import { buildQuestions } from "../../src/policies/jev-questions.ts";
import { ScriptedPolicy } from "../../src/policies/scripted.ts";
import { scroll } from "../../src/scans/compare.ts";
import { ROOT, tmpPath } from "../helpers.ts";
import { find, task } from "./support.ts";

let browser: Browser;

async function open(url: string, view: ViewChoice | null = null) {
  browser = await Browser.open(url, { view });
  return browser;
}

beforeEach(async () => {
  await open(task.startUrl(ROOT));
});

afterEach(async () => {
  await browser.close();
});

test("v2: elements beyond the viewport are offered with their own operations, and the marker stays the same", async () => {
  const settings = await loadTask("settings_long");
  await browser.close();
  const plain = await (await open(settings.startUrl(ROOT))).observe();
  await browser.close();
  const page = await (await open(settings.startUrl(ROOT), { whole: true })).observe();
  const weekly = find(page, (a) => a.label === "Weekly summary on");
  expect(weekly).toMatchObject({ kind: "click", offscreen: true });
  expect(weekly.at).toMatch(/^below \d+px$/);
  expect(find(plain, (a) => a.label === "Weekly summary on")).toBeUndefined();
  // The same marker apart from when the page was loaded (two separate loads).
  expect(page.marker.slice(1)).toEqual(plain.marker.slice(1));
});

test("v2: choosing an element beyond the viewport scrolls to it, then acts on it once", async () => {
  const settings = await loadTask("settings_long");
  await browser.close();
  await open(settings.startUrl(ROOT), { whole: true });
  const log = join(tmpPath(), "run.jsonl");
  const recorder = new Recorder(log);
  const script = [
    { operation: "CLICK", label: "Weekly summary on" },
    { operation: "CLICK", label: "Save settings" },
  ];
  const plan = { goal: settings.GOAL, steps: [], values: [], flow: "v2" as const };
  const result = await runAgent(browser, new ScriptedPolicy(script), plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(result.actions).toBe(2);
  const events = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.filter((e) => e.type === "into_view").map((e) => e.found)).toEqual([true, true]);
  expect((await settings.verify(browser)).success).toBe(true);
});

test("v1 refuses every action while the form's own text keeps changing; v2 checks only the target", {
  timeout: 60_000,
}, async () => {
  const signup = await loadTask("signup_ticker");
  const plan = { goal: signup.GOAL, steps: [], values: [] };
  for (const view of [null, { whole: true }]) {
    await browser.close();
    await open(signup.startUrl(ROOT), view);
    const log = join(tmpPath(), "run.jsonl");
    const recorder = new Recorder(log);
    const v2 = view ? { ...plan, flow: "v2" as const } : plan;
    // Jev takes seconds to answer; here, longer than one tick of the page.
    const scripted = new ScriptedPolicy(signup.SCRIPT);
    const slow = {
      name: "slow",
      calls: scripted.calls,
      config: () => scripted.config(),
      choose: async (...args: Parameters<ScriptedPolicy["choose"]>) => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return scripted.choose(...args);
      },
    };
    const result = await runAgent(browser, slow, v2, recorder, new Budget(30, 6));
    recorder.close();
    const stale = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === "stale");
    if (view) {
      expect(result.outcome).toBe("GOAL_REPORTED");
      expect((await signup.verify(browser)).success).toBe(true);
    } else {
      // Each refusal sees a changed page, so it never counts toward STUCK: the attempt runs out of decisions
      // with nothing typed or pressed. (The scripted policy moves on after a refusal, so each step is refused once.)
      expect(result).toMatchObject({ outcome: "ATTEMPT_BUDGET", actions: 0 });
      expect(stale.map((e) => e.changed)).toEqual([["text"], ["text"], ["scope_text"]]);
    }
  }
});

test("v2 tells what kind of page it is", async () => {
  await browser.close();
  await open(task.startUrl(ROOT), { whole: true });
  expect((await browser.observe()).status).toMatchObject({ kind: "ready" });
  await browser.evaluate("document.body.append(Object.assign(document.createElement('input'), {type: 'password'}))");
  expect((await browser.observe()).status.kind).toBe("sign_in");
  await browser.evaluate(
    "document.body.append(Object.assign(document.createElement('div'), {className: 'g-recaptcha'}))",
  );
  expect((await browser.observe()).status).toMatchObject({ kind: "check", signs: ["recaptcha"] });
});

test("v2: a whole page over Jev's token limit is fitted; the target a few screens down stays offered", {
  timeout: 60_000,
}, async () => {
  const catalog = await loadTask("catalog_big");
  await browser.close();
  await open(catalog.startUrl(ROOT), { whole: true });
  const plan = { goal: catalog.GOAL, steps: [], values: [], flow: "v2" as const };
  const page = await browser.observe();
  const [, targets, controls] = actionSpace(page.actions);
  const [questions] = buildQuestions(plan, targets, controls, valueChoices(plan));
  const whole = toJson({ model: "jev", state: modelState(page, [], plan), questions });
  expect(estimateTokens(whole)).toBeGreaterThan(60_000);
  const sent: string[] = [];
  // Jev presses the target when it is offered, then reports the goal.
  const fetch: Fetch = async (_url, init) => {
    sent.push(init.body);
    const request = JSON.parse(init.body);
    const pick = (criteria: Record<string, unknown>, choice: string) => ({
      choice,
      confidence: 0.9,
      probabilities: Object.fromEntries(Object.keys(criteria).map((k) => [k, k === choice ? 1 : 0])),
    });
    const offered = Object.entries(request.questions.click_target.criteria).find(([, c]) =>
      JSON.stringify(c).includes("Add Moss Towel 15 to cart"),
    );
    const done = sent.length > 1;
    const answers = {
      operation: pick(request.questions.operation.criteria, done ? "DONE" : offered ? "CLICK" : "NEEDS_HUMAN"),
      click_target: pick(request.questions.click_target.criteria, offered && !done ? offered[0] : "NOT_VISIBLE"),
    };
    return { status: 200, json: async () => ({ model: "jev", usage: {}, answers }) };
  };
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const policy = new JevPolicy({ fetch });
  const log = join(tmpPath(), "run.jsonl");
  const recorder = new Recorder(log);
  const result = await runAgent(browser, policy, plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(estimateTokens(sent[0])).toBeLessThanOrEqual(24_000);
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((e) => e.type === "call");
  expect(calls[0].dropped_elements).toBeGreaterThan(0);
  expect((await catalog.verify(browser)).success).toBe(true);
});

test("item_moved: the old link offers nothing; the shop's home page, saved as a service, finds the item", async () => {
  const moved = await loadTask("item_moved");
  await browser.close();
  await open(moved.startUrl(ROOT));
  const plan = { goal: moved.GOAL, steps: [], values: [] };
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  expect((await runAgent(browser, new ScriptedPolicy(moved.SCRIPT), plan, recorder)).outcome).toBe("BLOCKED");
  const offered = (await browser.observe()).actions.filter((a: Action) => a.kind !== "wait");
  expect(offered).toEqual([]);
  await browser.close();
  await open(pathToFileURL(join(ROOT, "research", "sites", "kinari_shop.html")).href);
  const script = [
    { operation: "TYPE_TEXT", label: "Search the shop", text: "Moss Towel 23" },
    { operation: "CLICK", label: "Find" },
    { operation: "CLICK", label: "Add Moss Towel 23 to cart" },
  ];
  const values = [{ label: "Search", value: "Moss Towel 23" }];
  const result = await runAgent(browser, new ScriptedPolicy(script), { ...plan, values }, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect((await moved.verify(browser)).success).toBe(true);
});

test("order_signin: the cart can be filled, the order only behind a sign-in no one can do", async () => {
  const order = await loadTask("order_signin");
  await browser.close();
  await open(order.startUrl(ROOT));
  const plan = { goal: order.GOAL, steps: [], values: [{ label: "Search", value: "Moss Towel 23" }] };
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const result = await runAgent(browser, new ScriptedPolicy(order.SCRIPT), plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("NEEDS_HUMAN");
  const page = await browser.observe();
  // The sign-in form is shown; a password field is never offered.
  const labels = page.actions.map((a: Action) => a.label);
  expect(labels).toContain("Sign in and place order");
  expect(labels).not.toContain("Password");
  expect(await order.verify(browser)).toEqual({
    success: true,
    evidence: { cart: ["Moss Towel 23"], signin_tried: false },
  });
});

test("off_plan_detour: the terms page stands in the way; signing out ends the task", async () => {
  const detour = await loadTask("off_plan_detour");
  await browser.close();
  await open(detour.startUrl(ROOT));
  expect((await detour.verify(browser)).success).toBe(false);
  const plan = { goal: detour.GOAL, steps: [], values: [] };
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const result = await runAgent(browser, new ScriptedPolicy(detour.SCRIPT), plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(await detour.verify(browser)).toEqual({
    success: true,
    evidence: { opened: "March 2026", signed_out: false },
  });
  // Choosing Sign out instead cannot be undone: the invoice is out of reach.
  await browser.close();
  await open(detour.startUrl(ROOT));
  const out = new ScriptedPolicy([
    { operation: "CLICK", label: "Invoices" },
    { operation: "CLICK", label: "Sign out" },
    { operation: "DONE" },
  ]);
  await runAgent(browser, out, plan, new Recorder(join(tmpPath(), "run.jsonl")));
  expect((await detour.verify(browser)).success).toBe(false);
});

test("off_plan_purge: the big Continue deletes three exports; Not now keeps them", async () => {
  const purge = await loadTask("off_plan_purge");
  await browser.close();
  await open(purge.startUrl(ROOT));
  expect((await purge.verify(browser)).success).toBe(false);
  const plan = { goal: purge.GOAL, steps: [], values: [] };
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const result = await runAgent(browser, new ScriptedPolicy(purge.SCRIPT), plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(await purge.verify(browser)).toEqual({
    success: true,
    evidence: { downloading: "March 2026 report", deleted: 0 },
  });
  // Pressing Continue gets the same page and destroys the exports: verify() fails.
  await browser.close();
  await open(purge.startUrl(ROOT));
  const go = new ScriptedPolicy([
    { operation: "CLICK", label: "March 2026 report" },
    { operation: "CLICK", label: "Continue" },
    { operation: "DONE" },
  ]);
  await runAgent(browser, go, plan, new Recorder(join(tmpPath(), "run.jsonl")));
  expect(await purge.verify(browser)).toEqual({
    success: false,
    evidence: { downloading: "March 2026 report", deleted: 3 },
  });
});

test("needs_extra_value: the company code is asked for only after Request quote", async () => {
  const quote = await loadTask("needs_extra_value");
  await browser.close();
  await open(quote.startUrl(ROOT));
  expect((await quote.verify(browser)).success).toBe(false);
  const before = (await browser.observe()).actions.map((a: Action) => a.label);
  expect(before).not.toContain("Company code");
  const plan = { goal: quote.GOAL, steps: [], values: [] };
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const result = await runAgent(browser, new ScriptedPolicy(quote.SCRIPT), plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(await quote.verify(browser)).toEqual({ success: true, evidence: { submitted: true, code_ok: true } });
  expect(await browser.evaluate("document.getElementById('error').hidden")).toBe(true);
});

test("canvas_seats: the seats are pixels, the list page has them as buttons", async () => {
  const seats = await loadTask("canvas_seats");
  await browser.close();
  await open(seats.startUrl(ROOT));
  expect((await seats.verify(browser)).success).toBe(false);
  const page = await browser.observe();
  expect(page.actions.map((a: Action) => a.label).join(" ")).not.toContain("B4");
  expect((await browser.unseen()).canvases).toBe(1);
  await browser.close();
  await open(seats.startUrl(ROOT).replace("canvas_seats.html", "seats-list.html"));
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const plan = { goal: seats.GOAL, steps: [], values: [] };
  await runAgent(browser, new ScriptedPolicy(seats.SCRIPT), plan, recorder);
  recorder.close();
  expect(await seats.verify(browser)).toEqual({ success: true, evidence: { seat: "B4" } });
});

test("a covered target does not run, and Jev is told what covers it; closing the cover lets it run", async () => {
  const wall = await loadTask("cookie_wall");
  await browser.close();
  await open(wall.startUrl(ROOT));
  const plan = { goal: wall.GOAL, steps: [], values: [] };
  const log = join(tmpPath(), "run.jsonl");
  const recorder = new Recorder(log);
  const history: HistoryEntry[] = [];
  const first = await runAgent(
    browser,
    new ScriptedPolicy([{ operation: "CLICK", label: "Weekly digest" }]),
    plan,
    recorder,
    new Budget(),
    { history },
  );
  // The scripted chooser moves on after a refused step; what matters is the refusal and what Jev is told.
  expect(first.actions).toBe(0);
  expect(history[0].action).toContain('did not run: Target is covered by a fixed div "We value your privacy"');
  const result = await runAgent(browser, new ScriptedPolicy(wall.SCRIPT), plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect((await wall.verify(browser)).success).toBe(true);
  const stale = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "stale");
  expect(stale[0].changed).toEqual(["target_covered"]);
});

test("a target under a sticky header is scrolled to the middle once, then clicked", async () => {
  const file = join(tmpPath(), "sticky.html");
  writeFileSync(
    file,
    `<style>header{position:sticky;top:0;height:240px;background:#eee}main{height:3000px}</style>
     <header>Site</header><main><p style="margin-top:900px"><button onclick="document.title='pressed'">Go</button></p></main>`,
  );
  await browser.close();
  await open(pathToFileURL(file).href);
  // Scroll so the button sits just under the top edge, where the header covers it.
  await browser.evaluate("scrollTo(0, document.querySelector('button').getBoundingClientRect().top + scrollY - 120)");
  const page = await browser.observe();
  const go = find(page, (a) => a.label === "Go");
  await browser.act(go, page);
  expect(await browser.evaluate("document.title")).toBe("pressed");
});

test("v2 never refuses a scroll or a wait for staleness; v1 does when the page's text has changed", async () => {
  const signup = await loadTask("signup_ticker");
  for (const view of [null, { whole: true }]) {
    await browser.close();
    await open(signup.startUrl(ROOT), view);
    const page = await browser.observe();
    await new Promise((resolve) => setTimeout(resolve, 900)); // The tip and the countdown tick every 400 ms.
    for (const id of ["wait", "scroll_down"]) {
      const action = find(page, (a) => a.id === id);
      const parts = await browser.staleParts(page, action);
      if (view) expect(parts).toEqual([]);
      else expect(parts).toContain("text");
    }
  }
});

test("a scan's own scroll is never refused for staleness, in v1 too; Jev's scroll is", async () => {
  const signup = await loadTask("signup_ticker");
  await browser.close();
  await open(signup.startUrl(ROOT));
  const page = await browser.observe();
  await new Promise((resolve) => setTimeout(resolve, 900));
  expect(await browser.staleParts(page, scroll(200))).toEqual([]);
  expect(
    await browser.staleParts(
      page,
      find(page, (a) => a.id === "wait"),
    ),
  ).toContain("text");
});

// Two servers on different hosts: the second one's frame is cross-origin (and cross-site) for the first one's page.
