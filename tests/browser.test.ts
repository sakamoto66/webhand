/** Real headless Chrome on the local fixtures. No model calls. */

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadTask } from "../research/tasks.ts";
import { Budget, runAgent } from "../src/agent.ts";
import { Browser, SETTLE_CAP_MS, type ViewChoice } from "../src/browser.ts";
import { toJson } from "../src/format.ts";
import { Recorder } from "../src/metrics.ts";
import { actionSpace, modelState, valueChoices } from "../src/policies/base.ts";
import { buildQuestions, estimateTokens, type Fetch, JevPolicy } from "../src/policies/jev.ts";
import { ScriptedPolicy } from "../src/policies/scripted.ts";
import { type Action, type HistoryEntry, type Page, StalePage } from "../src/types.ts";
import { ROOT, tmpPath } from "./helpers.ts";

const task = await loadTask("hotel_filter");

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

// biome-ignore lint/suspicious/noExplicitAny: observed actions are untyped JSON.
const find = (page: Page, test: (a: any) => boolean) => page.actions.find(test);

test("a scripted run passes independent verification", async () => {
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const plan = { goal: task.GOAL, steps: [], values: [] };
  const result = await runAgent(browser, new ScriptedPolicy(task.SCRIPT), plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect((await task.verify(browser)).success).toBe(true);
});

test("the verifier fails when the task was not done", async () => {
  expect((await task.verify(browser)).success).toBe(false);
});

test("a stale decision is not executed", async () => {
  const page = await browser.observe();
  const button = find(page, (a) => a.label === "Find stays");
  await browser.evaluate("document.getElementById('destination').value='changed'");
  await expect(browser.act(button, page)).rejects.toThrow(StalePage);
  // biome-ignore lint/suspicious/noExplicitAny: evidence is the task's own shape.
  expect(((await task.verify(browser)).evidence as any).opened_casa_flora).toBe(false);
});

test("a refused action names what changed: a form field or the scroll", async () => {
  let page = await browser.observe();
  const button = find(page, (a) => a.label === "Find stays");
  await browser.evaluate("document.getElementById('destination').value='changed'");
  await expect(browser.act(button, page)).rejects.toMatchObject({ changed: ["form_fields"] });
  page = await browser.observe();
  await browser.evaluate("scrollBy(0, 40)");
  const again = find(page, (a) => a.label === "Find stays");
  expect(await browser.staleParts(page, again)).toEqual(["scroll"]);
  expect(await browser.staleParts(page)).toEqual(["scroll", "text", "semantics"]);
});

test("unseen() counts the frames and canvases in the page", async () => {
  await browser.evaluate(
    "document.body.append(Object.assign(document.createElement('iframe'), {width: 50, height: 50}), " +
      "Object.assign(document.createElement('canvas'), {width: 50, height: 50}))",
  );
  expect(await browser.unseen()).toEqual({ frames: 1, canvases: 1, objects: 0 });
});

test("password values are not observed", async () => {
  await browser.evaluate(
    "const p=document.createElement('input');p.type='password';p.value='hunter2';" +
      "p.setAttribute('aria-label','Secret');document.body.prepend(p);",
  );
  const page = await browser.observe();
  expect(JSON.stringify(page)).not.toContain("hunter2");
  expect(page.actions.every((a: { label: string }) => a.label !== "Secret")).toBe(true);
});

test("open shadow DOM is observed and clickable", async () => {
  await browser.evaluate(`(() => {
    const host=document.createElement('div'); document.body.prepend(host);
    const root=host.attachShadow({mode:'open'});
    root.innerHTML='<p>Shadow notice</p><span id="t">Shadow save</span>'+
      '<button aria-labelledby="t">x</button><slot-host><span>Slotted go</span></slot-host>';
    const inner=root.querySelector('slot-host').attachShadow({mode:'open'});
    inner.innerHTML='<button><slot></slot></button>';
    root.querySelector('button').onclick=()=>host.dataset.saved='1';
    inner.querySelector('button').onclick=()=>host.dataset.went='1';
    window.__shadowHost=host;
  })()`);
  const page = await browser.observe();
  expect(page.text).toContain("Shadow notice");
  const save = find(page, (a) => a.label === "Shadow save");
  const go = find(page, (a) => a.label === "Slotted go");
  await browser.act(save, page);
  await browser.act(go, await browser.observe());
  expect(await browser.evaluate("({...window.__shadowHost.dataset})")).toEqual({ saved: "1", went: "1" });
});

test("script-clickable elements without a role are observed once", async () => {
  await browser.evaluate(`(() => {
    const box=document.createElement('div'); document.body.prepend(box);
    box.innerHTML='<h3 id="area" style="cursor:pointer">Kanto<span>AREA</span></h3>'+
      '<div style="cursor:pointer" id="card"><a href="#x">Card link</a></div>'+
      '<span onclick="1">Inline handler</span><div tabindex="0">Focusable</div>'+
      '<label style="cursor:pointer">Label text</label><p style="cursor:pointer"></p>'+
      '<iframe tabindex="0" title="Ad"></iframe>'+
      // An anchor's .host is a URL string, not a shadow host.
      '<a id="remote" href="https://example.com/x" style="display:block;padding:0">'+
      '<span style="display:block;height:40px">Remote link</span></a>';
    box.querySelector('#area').addEventListener('click', () => box.dataset.opened='1');
    box.querySelector('#remote').addEventListener('click', e => { e.preventDefault(); box.dataset.went='1'; });
    window.__box=box;
  })()`);
  let page = await browser.observe();
  const clickable = page.actions
    .filter((a: { role?: string }) => a.role === "clickable")
    .map((a: { label: string }) => a.label);
  expect(clickable).toEqual(["Kanto AREA", "Inline handler", "Focusable"]);
  expect(page.actions.filter((a: { label: string }) => a.label === "Card link")).toHaveLength(1);
  await browser.act(
    find(page, (a) => a.label === "Kanto AREA"),
    page,
  );
  expect(await browser.evaluate("window.__box.dataset.opened")).toBe("1");
  page = await browser.observe();
  const remote = find(page, (a) => a.label === "Remote link");
  expect(remote.role).toBe("link");
  await browser.act(remote, page); // The click lands on the span inside the link.
  expect(await browser.evaluate("window.__box.dataset.went")).toBe("1");
});

test("a wrapped inline link is clicked on one of its lines", async () => {
  await browser.evaluate(`(() => {
    const li=document.createElement('li'); li.style.cssText='list-style:none;width:400px';
    li.innerHTML='Leading text that fills most of the line <a id="wrapped" href="#w">Short<br>Next</a>';
    li.querySelector('a').addEventListener('click', e => { e.preventDefault(); li.dataset.went='1'; });
    document.body.prepend(li); window.__li=li;
  })()`);
  // The link starts at the end of one line and ends at the start of the next, so its box spans the line and
  // the center of that box falls on the leading text, outside the link.
  expect(
    await browser.evaluate(
      "(() => { const r=document.getElementById('wrapped').getBoundingClientRect();" +
        " return document.elementFromPoint(r.x+r.width/2, r.y+r.height/2) === window.__li; })()",
    ),
  ).toBe(true);
  const page = await browser.observe();
  await browser.act(
    find(page, (a) => a.label.startsWith("Short")),
    page,
  );
  expect(await browser.evaluate("window.__li.dataset.went")).toBe("1");
});

function fixture(name: string, html: string): string {
  const file = join(tmpPath(), name);
  writeFileSync(file, html);
  return pathToFileURL(file).href;
}

test("observe waits for content rendered after load", async () => {
  const url = fixture(
    "late.html",
    "<!doctype html><meta charset='utf-8'><body><h1>Shell</h1><script>" +
      "addEventListener('load', () => setTimeout(() => {" +
      "const b=document.createElement('button'); b.textContent='Loaded later'; document.body.append(b);" +
      "}, 100));</script></body>",
  );
  await browser.close();
  const observed = await (await open(url)).observe();
  expect(observed.text).toContain("Loaded later");
  expect(observed.actions.some((a: { label: string }) => a.label === "Loaded later")).toBe(true);
});

test("observe returns at the cap on a page that never settles", async () => {
  const url = fixture(
    "busy.html",
    "<!doctype html><body><p id='t'>0</p><script>setInterval(() => { t.textContent = Date.now(); }, 20);</script></body>",
  );
  await browser.close();
  await open(url);
  const started = performance.now();
  await browser.observe();
  expect(performance.now() - started).toBeLessThan(SETTLE_CAP_MS + 1500);
});

// --- Regions and views ---------------------------------------------------------------------

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

test("a screenshot is a PNG of the page", async () => {
  const png = await browser.screenshot();
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
});

test("a page check reports the document's HTTP status and bot-check markers, not page text", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(403, { "content-type": "text/html" });
    response.end('<title>Check</title><p>Verify you are human</p><iframe src="/recaptcha/frame"></iframe>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await browser.close();
    await open(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    const check = await browser.check();
    expect(check).toMatchObject({ http_status: 403, title: "Check", challenge: ["recaptcha"] });
    expect(check.text_chars).toBeGreaterThan(0);
    expect(JSON.stringify(check)).not.toContain("Verify");
  } finally {
    server.close();
  }
});

test("a page check on a normal page finds no bot-check markers", async () => {
  expect((await browser.check()).challenge).toEqual([]);
});

/** A page whose content is mostly below the viewport. */
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
  const plans = await loadTask("plan_more");
  await browser.close();
  await open(plans.startUrl(ROOT), { read: ["table"] });
  let page = await browser.observe();
  expect(await rows()).toBe(10);
  for (const loaded of [20, 30, 40]) {
    const last = page.actions.filter((a: Action) => a.kind === "reveal").at(-1);
    await browser.act(last as never, page);
    page = await browser.observe();
    for (let i = 0; i < 5 && (await rows()) < loaded; i++) page = await browser.observe();
    expect(await rows()).toBe(loaded);
  }
  expect(page.read.text).toMatch(/\nTuff \| [^|\n]+ \| €11 \| Choose Tuff\n/);
  expect((await plans.verify(browser)).success).toBe(false);
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
      JSON.stringify(c).includes("Add Moss Towel 23 to cart"),
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
  expect(estimateTokens(sent[0])).toBeLessThanOrEqual(40_000);
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((e) => e.type === "call");
  expect(calls[0].dropped_elements).toBeGreaterThan(0);
  expect((await catalog.verify(browser)).success).toBe(true);
});

test("item_moved: the old link offers nothing; the shop's home page, learned as a service, finds the item", async () => {
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
