/** Real headless Chrome on the local fixtures. No model calls. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runAgent } from "../src/agent.ts";
import { Browser, SETTLE_CAP_MS } from "../src/browser.ts";
import { Recorder } from "../src/metrics.ts";
import { ScriptedPolicy } from "../src/policies/scripted.ts";
import { loadTask } from "../src/tasks.ts";
import { type Page, StalePage } from "../src/types.ts";
import { ROOT, tmpPath } from "./helpers.ts";

const task = await loadTask("hotel_filter");

let browser: Browser;

async function open(url: string, view: Record<string, string[]> | null = null) {
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
