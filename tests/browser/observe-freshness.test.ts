/** Real headless Chrome on the local fixtures. No model calls. */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runAgent } from "../../src/agent/index.ts";
import { Browser, type ViewChoice } from "../../src/browser/index.ts";
import { SETTLE_CAP_MS } from "../../src/browser/scripts/index.ts";
import { Recorder } from "../../src/core/metrics.ts";
import { StalePage } from "../../src/core/types.ts";
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

test("observe waits for content rendered after load", async () => {
  vi.stubEnv("WEBHAND_SETTLE_QUIET_MS", "150");
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
