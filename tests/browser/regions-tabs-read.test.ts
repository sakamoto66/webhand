/** Real headless Chrome on the local fixtures. No model calls. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadTask } from "../../research/tasks.ts";
import { runAgent } from "../../src/agent/index.ts";
import { Browser, type ViewChoice } from "../../src/browser/index.ts";
import { Recorder } from "../../src/core/metrics.ts";
import { type Action, type Page, StalePage } from "../../src/core/types.ts";
import { actionSpace } from "../../src/policies/base.ts";
import { ScriptedPolicy } from "../../src/policies/scripted.ts";
import { ROOT, tmpPath } from "../helpers.ts";
import { find, fixture, task } from "./support.ts";

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

const DENSE = pathToFileURL(join(ROOT, "tasks", "fixtures", "dense.html")).href;
const FORM = "main:Booking/form:Booking";

// biome-ignore lint/suspicious/noExplicitAny: regions are untyped JSON.
const regions = (page: Page): Record<string, any> =>
  Object.fromEntries(page.regions.map((region: { key: string }) => [region.key, region]));

async function dense(view: Record<string, string[]> | null = null) {
  await browser.close();
  return open(DENSE, view);
}

test("without a view the outline shows what was cut", async () => {
  const page = await (await dense()).observe();
  const outline = regions(page);
  expect(page.omitted_actions).toBe(191);
  expect([outline["header:Dense shop/nav:Categories"].shown_actions, outline[FORM].shown_actions]).toEqual([250, 0]);
  expect(outline[FORM].actions).toBe(141);
  expect(outline["main:Booking/section:Notes"].position).toBe("below");
  expect(page.regions.every((region: object) => !("view" in region))).toBe(true);
  expect(page.text).not.toContain("## ");
});

test("a view shows focused regions first and leaves skipped ones out", async () => {
  const instance = await dense({ focus: ["form:Booking", "section:Notes"], skip: ["header"] });
  const page = await instance.observe();
  const labels = page.actions.filter((a: { node?: number }) => a.node).map((a: { label: string }) => a.label);
  expect(labels[0].startsWith("Arrival")).toBe(true);
  expect(labels).toContain("Book");
  expect(labels.some((label: string) => label.startsWith("Category"))).toBe(false);
  expect(page.text.startsWith(`## ${FORM}`)).toBe(true);
  expect(page.text).toContain("Cancellation is free"); // Focused text is read from the whole page.
  expect(page.text).not.toContain("Category 1");
  const outline = regions(page);
  expect(outline["header:Dense shop/nav:Categories"].view).toBe("skip");
  expect(outline[FORM].view).toBe("focus");
  expect(outline[FORM].shown_actions).toBe(141);
});

test("the view does not change freshness", async () => {
  const instance = await dense();
  const plain = await instance.observe();
  instance.view = { focus: ["form"], skip: ["nav"] };
  const viewed = await instance.observe();
  for (const key of ["marker", "page_key", "guards"]) expect(viewed[key]).toEqual(plain[key]);
  expect(await instance.fresh(viewed)).toBe(true);
});

test("a focused action runs like any other", async () => {
  const instance = await dense({ focus: ["form:Booking"] });
  const page = await instance.observe();
  await instance.act(
    find(page, (a) => a.label === "Book"),
    page,
  );
  expect(await instance.evaluate("document.body.dataset.booked")).toBe("1");
});

test("region keys are stable and hold no secrets", async () => {
  const instance = await dense();
  const first = await instance.observe();
  const second = await instance.observe();
  expect(first.regions.map((r: { key: string }) => r.key)).toEqual(second.regions.map((r: { key: string }) => r.key));
  instance.view = { focus: ["form"] };
  expect(JSON.stringify(await instance.observe())).not.toContain("hunter2");
});

test("an open dialog comes first in a view", async () => {
  const instance = await dense();
  await instance.evaluate("document.getElementById('welcome').showModal()");
  instance.view = { focus: ["form"] };
  const page = await instance.observe();
  expect(page.actions[0].label).toBe("Close offer");
  expect(page.text.startsWith("## dialog:Welcome")).toBe(true);
});

test("a bare kind matches any region of that kind and the deepest match wins", async () => {
  const page = await (await dense({ focus: ["form"], skip: ["main"] })).observe();
  const outline = regions(page);
  expect(outline[FORM].view).toBe("focus");
  expect(outline["main:Booking"].view).toBe("skip");
  expect(page.text).not.toContain("Cancellation");
});

test("a heading names a region only when it opens it", async () => {
  const url = fixture(
    "names.html",
    "<!doctype html><meta charset='utf-8'><body>" +
      "<form><label>Date <input></label><h3>Total</h3></form>" +
      "<section aria-label='Notes'><p>Note</p></section><aside><h2>Help</h2><a href='#h'>Ask</a></aside></body>",
  );
  await browser.close();
  const keys = (await (await open(url)).observe()).regions.map((r: { key: string }) => r.key);
  expect(keys).toEqual(["form", "section:Notes", "aside:Help"]);
});

test.each([null, { focus: ["form:Booking"], skip: ["header"] }])(
  "dense booking passes verification with view %j",
  async (view) => {
    const denseTask = await loadTask("dense_booking");
    await browser.close();
    const instance = await open(denseTask.startUrl(ROOT), view);
    expect((await denseTask.verify(instance)).success).toBe(false);
    const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
    const plan = { goal: denseTask.GOAL, steps: [], values: [] };
    const result = await runAgent(instance, new ScriptedPolicy(denseTask.SCRIPT), plan, recorder);
    recorder.close();
    expect(result.outcome).toBe("GOAL_REPORTED");
    expect((await denseTask.verify(instance)).success).toBe(true);
  },
);

test("a link that opens a new tab is offered as a tab to switch to, and the form in it can be filled", async () => {
  const tabTask = await loadTask("tab_form");
  await browser.close();
  const instance = await open(tabTask.startUrl(ROOT));
  expect((await instance.observe()).tabs).toBeUndefined();
  expect((await tabTask.verify(instance)).success).toBe(false);
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const plan = { goal: tabTask.GOAL, steps: [], values: [] };
  const result = await runAgent(instance, new ScriptedPolicy(tabTask.SCRIPT), plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(result.page.tabs).toEqual({ count: 2, current: 2 });
  expect((await tabTask.verify(instance)).success).toBe(true);
});

test("tab controls name the other tabs; a switch checks that the tabs are still the ones observed", async () => {
  const tabTask = await loadTask("tab_form");
  await browser.close();
  const instance = await open(tabTask.startUrl(ROOT));
  const first = await instance.observe();
  await instance.act(
    find(first, (a) => a.label === "Open guest form"),
    first,
  );
  let page: Page = await instance.observe();
  expect(page.tabs).toEqual({ count: 2, current: 1 });
  const control = find(page, (a) => a.kind === "tab");
  expect(control).toMatchObject({ id: "tab_2", tab: 2, label: "Switch to tab 2: Guest registration" });
  expect(page.actions.at(-1).id).toBe("wait");
  expect(actionSpace(page.actions)[2].has("TAB_2")).toBe(true);
  // A third tab makes the observed numbering wrong: nothing is switched.
  await instance.context.newPage();
  await expect(instance.act(control, page)).rejects.toThrow(StalePage);
  expect((await instance.observe()).url).toContain("tab_start.html");
  // A tab that closes itself leaves the run on the last tab still open.
  page = await instance.observe();
  await instance.context.pages()[2].close();
  await instance.act(
    find(page, (a) => a.kind === "tab" && a.tab === 2),
    await instance.observe(),
  );
  await instance.context.pages()[1].close();
  expect((await instance.observe()).url).toContain("tab_start.html");
});

function longPage(extra = ""): string {
  const file = join(tmpPath(), "long.html");
  writeFileSync(
    file,
    `<title>Long</title><nav><a href="#a">Nav home</a></nav><main><h1>Top</h1><p>Intro paragraph.</p>
    <div style="height:3000px"></div>
    <h2>Prices</h2><p>Prices change monthly.</p>
    <table><caption>Plans</caption><tr><th>Plan</th><th>Price</th></tr><tr><td>Basic</td><td>10</td></tr>
    <tr><td>Pro</td><td>25</td></tr></table>
    <ul><li>First item</li><li>Second item</li></ul>
    <a href="#b">Contact us</a><button>Buy now</button><input type="password" value="hunter2" aria-label="Pass">
    <img alt="A chart of prices" src="data:,"><figure><figcaption>Figure caption</figcaption></figure>${extra}</main>`,
  );
  return pathToFileURL(file).href;
}

test("without --read the page has no read layer", async () => {
  await browser.close();
  await open(longPage());
  expect((await browser.observe()).read).toBeUndefined();
});

test("the read layer gives chosen kinds from below the viewport, with where they are", async () => {
  await browser.close();
  await open(longPage(), { read: ["table"] });
  const page = await browser.observe();
  expect(page.read.kinds).toEqual(["outline", "table"]);
  expect(page.read.text).toContain("@ below 2");
  expect(page.read.text).toContain("h2 Prices");
  expect(page.read.text).toMatch(/## table 1 @ below \d+px: Plans \(3 rows\)\nPlan \| Price\nBasic \| 10\nPro \| 25/);
  expect(page.read.text).not.toContain("First item");
  expect(page.text).not.toContain("Basic"); // The viewport text is unchanged.
  expect(page.read.text).not.toContain("Intro paragraph"); // In view already; not repeated.
  expect(await browser.fresh(page)).toBe(true);
});

test("every kind is classified once, field values are never read, and skipped regions are left out", async () => {
  await browser.close();
  await open(longPage(), { skip: ["nav"], read: ["text", "table", "list", "link", "control", "media"] });
  const { read } = await browser.observe();
  expect(read.text).toContain("Prices change monthly.");
  expect(read.text).toContain("- First item");
  expect(read.text).toContain("- Contact us");
  expect(read.text).toMatch(/- button "Buy now"/);
  expect(read.text).toContain("- A chart of prices");
  expect(read.text).toContain("- Figure caption");
  expect(read.text).not.toContain("hunter2");
  expect(read.text).not.toContain("Nav home");
  expect(read.text.match(/Basic/g)).toHaveLength(1); // Table text is not repeated as text.
});

test("the read layer stays within its limit and says how much of each kind is left", async () => {
  await browser.close();
  const filler = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i} ${"word ".repeat(20)}</p>`).join("");
  await open(longPage(filler), { read: ["text", "table"] });
  const { read } = await browser.observe();
  expect(read.text.length).toBeLessThanOrEqual(read.limit + 200);
  expect(read.chars.table[0]).toBe(read.chars.table[1]); // A small kind is shown whole.
  expect(read.chars.text[0]).toBeLessThan(read.chars.text[1]);
  expect(read.text).toMatch(/\.\.\. \d+ more characters/);
});

test("the plan_lowest task passes verification only for the cheapest plan, and its table is below the viewport", async () => {
  const plans = await loadTask("plan_lowest");
  await browser.close();
  await open(plans.startUrl(ROOT), { read: ["table"] });
  const page = await browser.observe();
  expect(page.text).not.toContain("€12");
  expect(page.read.text).toMatch(/## table 1 @ below \d+px: Every plan and its monthly price \(41 rows\)/);
  expect(page.read.text).toMatch(/\nFlax \| [^|\n]+ \| €12 \| Choose Flax\n/);
  expect((await plans.verify(browser)).success).toBe(false);
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const plan = { goal: plans.GOAL, steps: [], values: [] };
  const result = await runAgent(browser, new ScriptedPolicy(plans.SCRIPT), plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect((await plans.verify(browser)).success).toBe(true);
});

const reveal = (page: Page, label: string) =>
  page.actions.find((a: Action) => a.kind === "reveal" && a.label === `Scroll to ${label}`);
const rows = () => browser.evaluate("document.querySelectorAll('#plans tr').length - 1");

test("without a read layer, nothing beyond the viewport is offered", async () => {
  const plans = await loadTask("plan_lowest");
  await browser.close();
  await open(plans.startUrl(ROOT));
  const page = await browser.observe();
  expect(page.actions.some((a: Action) => a.kind === "reveal")).toBe(false);
});

test("SCROLL_TO brings an element beyond the viewport into view without clicking it", async () => {
  const plans = await loadTask("plan_lowest");
  await browser.close();
  await open(plans.startUrl(ROOT), { read: ["table"] });
  let page = await browser.observe();
  const target = reveal(page, "Choose Flax");
  expect(target?.at).toMatch(/^below \d+px$/);
  expect(page.actions.some((a: Action) => a.kind === "click" && a.label === "Choose Flax")).toBe(false);
  await browser.act(target as never, page);
  expect(await browser.evaluate("document.body.dataset.chosen ?? null")).toBe(null);
  page = await browser.observe();
  const click = page.actions.find((a: Action) => a.kind === "click" && a.label === "Choose Flax");
  expect(click).toBeDefined();
  await browser.act(click as never, page);
  expect((await plans.verify(browser)).success).toBe(true);
});

test("SCROLL_TO on a removed element changes nothing", async () => {
  const plans = await loadTask("plan_lowest");
  await browser.close();
  await open(plans.startUrl(ROOT), { read: ["table"] });
  const page = await browser.observe();
  await browser.evaluate("document.querySelector('[data-plan=Flax]').closest('tr').remove()");
  await expect(browser.act(reveal(page, "Choose Flax") as never, page)).rejects.toThrow(StalePage);
  expect(await browser.evaluate("scrollY")).toBe(0);
});

test("in a list that loads as it is scrolled, SCROLL_TO its last element loads more", async () => {
  vi.stubEnv("WEBHAND_SETTLE_QUIET_MS", "150");
  const plans = await loadTask("plan_more");
  await browser.close();
  await open(plans.startUrl(ROOT), { read: ["table"] });
  let page = await browser.observe();
  expect(await rows()).toBe(10);
  for (const loaded of [20, 30, 40]) {
    const last = page.actions.filter((a: Action) => a.kind === "reveal").at(-1);
    expect(last).toBeDefined();
    await browser.act(last as never, page);
    // Wait until the newly loaded rows are in the DOM before observing, so `page` never holds the pre-load snapshot.
    await vi.waitFor(async () => expect(await rows()).toBe(loaded), { timeout: 10_000, interval: 100 });
    page = await browser.observe();
  }
  expect(page.read.text).toMatch(/\nTuff \| [^|\n]+ \| €11 \| Choose Tuff\n/);
  expect((await plans.verify(browser)).success).toBe(false);
});
