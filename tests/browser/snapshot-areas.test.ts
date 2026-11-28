/** Real headless Chrome tests for 4-stage DOM-aware area chunking (`view.areas=true`). No model calls. */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Browser, type ViewChoice } from "../../src/browser/index.ts";
import type { AreaChunk } from "../../src/browser/snapshot.ts";
import { type Action, type Page, StalePage } from "../../src/core/types.ts";
import { ROOT } from "../helpers.ts";
import { fixture } from "./support.ts";

let browser: Browser | null = null;

async function open(url: string, view: ViewChoice | null = null): Promise<Browser> {
  if (browser) await browser.close();
  browser = await Browser.open(url, { view });
  return browser;
}

afterEach(async () => {
  if (browser) {
    await browser.close();
    browser = null;
  }
});

const DENSE = pathToFileURL(join(ROOT, "tasks", "fixtures", "dense.html")).href;

const areasOf = (page: Page): AreaChunk[] => page.areas ?? [];

test("table rows slice with inherited thead column headers and breadcrumbs", async () => {
  const rows = Array.from(
    { length: 80 },
    (_, i) =>
      `<tr><td>Plan ${i + 1}</td><td>${(i + 1) * 10} GB</td><td>$${10 + i}</td><td><button>Choose ${i + 1}</button></td></tr>`,
  ).join("");
  const url = fixture(
    "areas-table.html",
    `<!doctype html><meta charset="utf-8"><title>Plans</title><body><main><h1>Pricing</h1>
    <table aria-label="Plans">
      <thead><tr><th>Plan</th><th>Storage</th><th>Price</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></main></body>`,
  );
  const instance = await open(url, { areas: true });
  const page = await instance.observe();
  const tableChunks = areasOf(page).filter((a) => a.kind === "table");
  expect(tableChunks.length).toBeGreaterThanOrEqual(2);

  const groupIds = new Set(tableChunks.map((c) => c.parent_group));
  expect(groupIds.size).toBe(1);
  expect(tableChunks[0].parent_group).toBeTruthy();

  tableChunks.forEach((chunk, index) => {
    expect(chunk.columns).toEqual(["Plan", "Storage", "Price", "Action"]);
    expect(chunk.slice).toEqual({ index: index + 1, total: tableChunks.length });
    expect(chunk.text.startsWith("Plan | Storage | Price | Action")).toBe(true);
    expect(chunk.breadcrumb).toContain("table:Plans");
    expect(chunk.breadcrumb).toContain(`[slice ${index + 1}/${tableChunks.length}]`);
    expect(chunk.breadcrumb).toContain("[cols: Plan, Storage, Price, Action]");
    for (const nodeId of chunk.action_nodes) {
      const act = page.actions.find((a: Action) => a.node === nodeId);
      expect(act?.area).toBe(chunk.id);
    }
  });
});

test("400 repeated cards split into sliced groups covering all card actions", async () => {
  const cards = Array.from(
    { length: 400 },
    (_, i) =>
      `<article class="product-card"><h3>Card ${i + 1}</h3><p>Item description number ${i + 1}</p><button>Select ${i + 1}</button></article>`,
  ).join("");
  const url = fixture(
    "areas-cards.html",
    `<!doctype html><meta charset="utf-8"><title>Catalog</title><body><main><h2>Catalog</h2><div class="card-grid">${cards}</div></main></body>`,
  );
  const instance = await open(url, { areas: true });
  const page = await instance.observe();
  const cardChunks = areasOf(page).filter((a) => a.parent_group && a.slice);
  expect(cardChunks.length).toBeGreaterThanOrEqual(8);
  expect(cardChunks.length).toBeLessThanOrEqual(40);

  const uniqueNodes = new Set(cardChunks.flatMap((c) => c.action_nodes));
  expect(uniqueNodes.size).toBe(400);

  for (const chunk of cardChunks) {
    expect(chunk.slice?.total).toBe(cardChunks.length);
    expect(chunk.action_count).toBeGreaterThan(0);
    expect(chunk.action_preview.length).toBeGreaterThan(0);
    expect(chunk.breadcrumb).toContain(`[slice ${chunk.slice?.index}/${chunk.slice?.total}]`);
  }

  const domActions = page.actions.filter((a: Action) => Number.isInteger(a.node));
  expect(domActions.every((a: Action) => typeof a.area === "string" && a.area.startsWith("a"))).toBe(true);
});

test("300 links and form are separated into distinct chunks and secrets are never read", async () => {
  const instance = await open(DENSE, { areas: true });
  const page = await instance.observe();
  expect(page.omitted_actions).toBe(0);
  expect(JSON.stringify(page)).not.toContain("hunter2-dense");

  const areas = areasOf(page);
  const navChunks = areas.filter((a) => a.kind === "nav");
  const formChunks = areas.filter((a) => a.kind === "form");
  expect(navChunks.length).toBeGreaterThanOrEqual(5);
  expect(formChunks.length).toBe(1);

  const form = formChunks[0];
  expect(form.name).toBe("Booking");
  const formActions = page.actions.filter((a: Action) => a.area === form.id);
  expect(formActions.some((a: Action) => a.label === "Book")).toBe(true);
  expect(formActions.some((a: Action) => a.label === "Guest")).toBe(true);
  expect(formActions.some((a: Action) => a.label.startsWith("Arrival"))).toBe(true);
  expect(navChunks.every((c) => !c.action_nodes.some((n) => form.action_nodes.includes(n)))).toBe(true);

  const fileUrl = fixture(
    "areas-secret-fields.html",
    `<!doctype html><meta charset="utf-8"><title>Secret</title><body><form aria-label="Auth">
      <label>Token <input type="password" value="pw-secret-999"></label>
      <input type="hidden" name="csrf" value="hidden-secret-888">
      <label>Attachment <input type="file"></label>
      <button>Send</button>
    </form></body>`,
  );
  const secPage = await (await open(fileUrl, { areas: true })).observe();
  expect(JSON.stringify(secPage)).not.toContain("pw-secret-999");
  expect(JSON.stringify(secPage)).not.toContain("hidden-secret-888");
});

test("div-only SPA detects header, sidebar, main, footer, and overlay by geometry", async () => {
  const url = fixture(
    "areas-div-spa.html",
    `<!doctype html><meta charset="utf-8"><title>Div SPA</title>
    <style>
      body { margin: 0; font: 14px sans-serif; }
      .top-header { height: 60px; width: 100%; background: #eee; }
      .workspace { display: flex; min-height: 500px; width: 100%; }
      .left-sidebar { width: 220px; background: #f5f5f5; }
      .main-content { flex: 1; padding: 16px; }
      .site-footer { height: 60px; width: 100%; background: #ddd; }
      .floating-overlay { position: fixed; right: 20px; bottom: 20px; width: 260px; height: 140px; z-index: 1000; background: #fff; border: 1px solid #000; }
    </style>
    <body>
      <div class="app-shell">
        <div class="top-header"><a href="#home">App Home</a></div>
        <div class="workspace">
          <div class="left-sidebar"><a href="#dash">Dashboard</a><a href="#settings">Settings</a></div>
          <div class="main-content"><div class="hero">Welcome to Workspace</div><button>Create item</button></div>
        </div>
        <div class="site-footer"><a href="#privacy">Privacy</a></div>
        <div class="floating-overlay"><div>Help widget</div><button>Open chat</button></div>
      </div>
    </body>`,
  );
  const instance = await open(url, { areas: true });
  const page = await instance.observe();
  const kinds = areasOf(page).map((a) => a.kind);
  expect(kinds).toContain("header");
  expect(kinds).toContain("sidebar");
  expect(kinds).toContain("main");
  expect(kinds).toContain("footer");
  expect(kinds).toContain("overlay");
  expect(areasOf(page).every((a) => Boolean(a.breadcrumb) && ["above", "visible", "below"].includes(a.position))).toBe(
    true,
  );
});

test("open dialog, alert, error display, and focused input are pinned and never merged with unpinned tiny areas", async () => {
  const url = fixture(
    "areas-pin.html",
    `<!doctype html><meta charset="utf-8"><title>Pinning</title><body>
      <header><a href="#h">Top</a></header>
      <main>
        <div role="alert">Maintenance scheduled at midnight</div>
        <section aria-label="Small A"><p>A</p></section>
        <section aria-label="Small B"><p>B</p></section>
        <form aria-label="Checkout">
          <label>Email <input id="email" aria-invalid="true" aria-errormessage="email-err"></label>
          <span id="email-err" class="error">Invalid email</span>
        </form>
        <form aria-label="Search">
          <label>Query <input id="q"></label>
        </form>
      </main>
      <dialog open aria-label="Confirm">
        <p>Confirm action?</p>
        <button>Confirm</button>
      </dialog>
      <script>document.getElementById('q').focus();</script>
    </body>`,
  );
  const instance = await open(url, { areas: true });
  const page = await instance.observe();
  const areas = areasOf(page);

  const dialog = areas.find((a) => a.kind === "dialog");
  const alert = areas.find((a) => a.kind === "alert");
  const checkout = areas.find((a) => a.kind === "form" && a.name === "Checkout");
  const search = areas.find((a) => a.kind === "form" && a.name === "Search");
  const header = areas.find((a) => a.kind === "header");

  expect(dialog).toMatchObject({ pinned: true, pin_reason: "dialog" });
  expect(alert).toMatchObject({ pinned: true, pin_reason: "alert" });
  expect(checkout).toMatchObject({ pinned: true, pin_reason: "error" });
  expect(search).toMatchObject({ pinned: true, pin_reason: "active_element" });
  expect(header).toMatchObject({ pinned: false });
  expect(header?.pin_reason).toBeUndefined();
});

test("deep chunk elements register guards and stay consistent with Browser.fresh and Browser.act", async () => {
  const filler = `<div style="height: 2800px">Spacer</div>`;
  const url = fixture(
    "areas-deep.html",
    `<!doctype html><meta charset="utf-8"><title>Deep</title><body>
      <main>
        <h1>Top</h1>
        ${filler}
        <section aria-label="Deep target">
          <h2>Deep section</h2>
          <p id="status-text">Ready to trigger</p>
          <button id="deep-btn" onclick="document.body.dataset.deep='clicked'">Trigger deep</button>
        </section>
      </main>
    </body>`,
  );
  const instance = await open(url, { areas: true });
  const page = await instance.observe();
  const deepChunk = areasOf(page).find((a) => a.name === "Deep target");
  expect(deepChunk).toBeDefined();
  expect(deepChunk?.position).toBe("below");
  expect(deepChunk?.y).toBeGreaterThan(2000);

  const deepAction = page.actions.find((a: Action) => a.label === "Trigger deep");
  expect(deepAction).toBeDefined();
  expect(deepAction.area).toBe(deepChunk?.id);
  expect(page.guards[String(deepAction.node)]).toBeTruthy();

  expect(await instance.fresh(page)).toBe(true);
  expect(await instance.fresh(page, deepAction)).toBe(true);

  await instance.evaluate("document.getElementById('status-text').textContent='Mutated'");
  expect(await instance.fresh(page, deepAction)).toBe(false);
  await expect(instance.act(deepAction, page)).rejects.toThrow(StalePage);

  const refreshed = await instance.observe();
  const freshDeepAction = refreshed.actions.find((a: Action) => a.label === "Trigger deep");
  expect(freshDeepAction).toBeDefined();
  await instance.act(freshDeepAction, refreshed);
  expect(await instance.evaluate("document.body.dataset.deep")).toBe("clicked");
});

test("omitting view.areas or setting areas=false preserves legacy output and caps", async () => {
  const plain = await (await open(DENSE)).observe();
  expect(plain.areas).toBeUndefined();
  expect(plain.omitted_actions).toBe(191);
  expect(plain.actions.every((a: Action) => !("area" in a))).toBe(true);

  const explicitFalse = await (await open(DENSE, { areas: false })).observe();
  expect(explicitFalse.areas).toBeUndefined();
  expect(explicitFalse.omitted_actions).toBe(191);
  expect(explicitFalse.actions.every((a: Action) => !("area" in a))).toBe(true);
});
