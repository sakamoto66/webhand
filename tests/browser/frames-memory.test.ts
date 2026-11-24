/** Real headless Chrome on the local fixtures. No model calls. */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadTask } from "../../research/tasks.ts";
import { Budget, runAgent } from "../../src/agent/index.ts";
import { Browser, type ViewChoice } from "../../src/browser/index.ts";
import { Recorder } from "../../src/core/metrics.ts";
import type { HistoryEntry, Page } from "../../src/core/types.ts";
import { ScriptedPolicy } from "../../src/policies/scripted.ts";
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

async function framePages() {
  const inner = `<!doctype html><title>inner</title><h1>Pay</h1>
    <input aria-label="Card number" id="card">
    <button id="buy" onclick="document.title='bought:'+document.getElementById('card').value">Buy now</button>`;
  const serve = (body: string) =>
    createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(request.url === "/inner" ? inner : body);
    });
  const far = serve("");
  await new Promise<void>((resolve) => far.listen(0, "localhost", resolve));
  const farPort = (far.address() as AddressInfo).port;
  const near = serve(
    `<!doctype html><body style="margin:0"><button>Top</button><div style="height:300px"></div>
     <iframe id="far" src="http://localhost:${farPort}/inner" width="320" height="200"></iframe>`,
  );
  await new Promise<void>((resolve) => near.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(near.address() as AddressInfo).port}/`,
    close: () => {
      near.close();
      far.close();
    },
  };
}

test("v2: elements inside a cross-origin frame are offered, typed into and clicked where they are", async () => {
  const pages = await framePages();
  try {
    await browser.close();
    await open(pages.url, { whole: true });
    let page = await browser.observe();
    const card = find(page, (a) => a.label === "Card number" && a.kind === "fill");
    const buy = find(page, (a) => a.label === "Buy now");
    expect(card?.frame).toBeGreaterThan(0);
    expect(buy?.node).toBeGreaterThan(1_000_000);
    expect(find(page, (a) => a.label === "Top")?.frame).toBeUndefined();
    expect(page.actions.at(-1).id).toBe("wait");
    expect(page.status.unseen.frames).toBe(0);
    expect(page.frames_log).toEqual({ found: 1, read: 1, elements: 3, skipped: {} });
    expect(await browser.fresh(page, card)).toBe(true);
    await browser.act(card, page, "4242");
    page = await browser.observe();
    await browser.act(
      find(page, (a) => a.label === "Buy now"),
      page,
    );
    const title = await browser.frames()[1].evaluate(() => document.title);
    expect(title).toBe("bought:4242");
  } finally {
    pages.close();
  }
});

test("v2: a scripted run fills and clicks inside an iframe, and the verifier reads the frame's own state", async () => {
  const checkout = await loadTask("frame_checkout");
  await browser.close();
  await open(checkout.startUrl(ROOT), { whole: true });
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const plan = { goal: checkout.GOAL, steps: [], values: [], flow: "v2" as const };
  expect((await checkout.verify(browser)).success).toBe(false);
  const history: HistoryEntry[] = [];
  const result = await runAgent(browser, new ScriptedPolicy(checkout.SCRIPT), plan, recorder, new Budget(), {
    history,
  });
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect((await checkout.verify(browser)).success).toBe(true);
  // Typing and pressing inside the frame change the page, though the page's own text and fields stay as they were.
  expect(history.map((h) => h.page_changed)).toEqual([true, true]);
});

test("without whole, the frame's elements are not offered", async () => {
  const checkout = await loadTask("frame_checkout");
  await browser.close();
  const page = await (await open(checkout.startUrl(ROOT))).observe();
  expect(find(page, (a) => a.label === "Place order")).toBeUndefined();
  expect(page.frames_log).toBeUndefined();
});

test("a tracking-pixel frame is not counted as a part webhand cannot see", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<title>T</title><iframe width="1" height="1" src="about:blank"></iframe><iframe width="300" height="100" src="about:blank"></iframe>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await browser.close();
    await open(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    expect((await browser.unseen()).frames).toBe(1);
    await browser.close();
    const page = await (
      await open(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { whole: true })
    ).observe();
    // The large frame is blank, so nothing of it is read, and one is left unseen.
    expect(page.status.unseen.frames).toBeLessThanOrEqual(1);
  } finally {
    server.close();
  }
});

test("v2: a run remembers what its clicks did for the next run, and never what was typed", async () => {
  const { SiteMemory } = await import("../../src/storage/memory.ts");
  const settings = await loadTask("settings_long");
  await browser.close();
  await open(settings.startUrl(ROOT), { whole: true });
  const dir = join(tmpPath(), "memory");
  const plan = { goal: settings.GOAL, steps: [], values: [], flow: "v2" as const };
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const script = [
    { operation: "CLICK", label: "Weekly summary on" },
    { operation: "CLICK", label: "Save settings" },
  ];
  await runAgent(browser, new ScriptedPolicy(script), plan, recorder, new Budget(), { memory: new SiteMemory(dir) });
  recorder.close();
  const saved = JSON.parse(readFileSync(join(dir, "local.json"), "utf8"));
  const transitions = Object.values(saved.pages).flatMap((p) =>
    Object.keys((p as { transitions: object }).transitions),
  );
  expect(transitions).toEqual(expect.arrayContaining(["click|Weekly summary on", "click|Save settings"]));
});

test("v2: a run that finished as done leaves hints, and the next run's Jev state offers them on the same page", async () => {
  const { SiteMemory } = await import("../../src/storage/memory.ts");
  const menu = await loadTask("menu_invoice");
  const dir = join(tmpPath(), "memory");
  await browser.close();
  await open(menu.startUrl(ROOT), { whole: true });
  const plan = { goal: menu.GOAL, steps: [], values: [], flow: "v2" as const };
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const history: HistoryEntry[] = [];
  const memory = new SiteMemory(dir);
  const result = await runAgent(browser, new ScriptedPolicy(menu.SCRIPT), plan, recorder, new Budget(), {
    history,
    memory,
  });
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect((await menu.verify(browser)).success).toBe(true);
  expect(memory.hints(menu.startUrl(ROOT))).toEqual([]);
  // The invoice's Download sits in a list item: its label (a month) is the page's content, so it is not kept.
  expect(readFileSync(join(dir, "local.json"), "utf8")).not.toContain("Download March");
  memory.confirm(history);
  const hints = memory.hints(menu.startUrl(ROOT));
  expect(hints.map((h) => h.label)).toEqual(["More"]);
  // The next run sees them in the state Jev is asked about, on the start page only.
  const seen: unknown[] = [];
  const spy = {
    name: "spy",
    calls: [],
    config: () => ({}),
    choose: async (page: Page) => {
      seen.push(page.known ?? null);
      return new ScriptedPolicy([]).choose(page, plan, []);
    },
  };
  await browser.close();
  await open(menu.startUrl(ROOT), { whole: true });
  const againLog = join(tmpPath(), "again.jsonl");
  const again = new Recorder(againLog);
  await runAgent(browser, spy as never, plan, again, new Budget(), { memory: new SiteMemory(dir) });
  again.close();
  expect(seen[0]).toEqual(hints);
  const offered = readFileSync(againLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((e) => e.type === "known_offered");
  expect(offered[0]).toMatchObject({ count: 1 });
});

test("menu_orders: a scripted run opens the Orders page, and the verifier reads the page that is open", async () => {
  const orders = await loadTask("menu_orders");
  await browser.close();
  await open(orders.startUrl(ROOT), { whole: true });
  expect((await orders.verify(browser)).success).toBe(false);
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const plan = { goal: orders.GOAL, steps: [], values: [], flow: "v2" as const };
  const result = await runAgent(browser, new ScriptedPolicy(orders.SCRIPT), plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect((await orders.verify(browser)).success).toBe(true);
});

test("menu_invoice_moved: the invoices are under Tools now, and the scripted run finds them", async () => {
  const moved = await loadTask("menu_invoice_moved");
  await browser.close();
  await open(moved.startUrl(ROOT), { whole: true });
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const plan = { goal: moved.GOAL, steps: [], values: [], flow: "v2" as const };
  const result = await runAgent(browser, new ScriptedPolicy(moved.SCRIPT), plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect((await moved.verify(browser)).success).toBe(true);
});

test("two_parts: the second part, pinning the note, can be done by a scripted run", async () => {
  const two = await loadTask("two_parts");
  await browser.close();
  await open(two.startUrl(ROOT), { whole: true });
  expect((await two.verify(browser)).success).toBe(false);
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const plan = { goal: two.GOAL, steps: [], values: [], flow: "v2" as const };
  const result = await runAgent(browser, new ScriptedPolicy(two.SCRIPT), plan, recorder);
  recorder.close();
  expect(result.outcome).toBe("GOAL_REPORTED");
  expect((await two.verify(browser)).success).toBe(true);
});
