/** Real headless Chrome tests for 4-stage DOM-aware area chunking (`view.areas=true`). No model calls. */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { Browser, type ViewChoice } from "../../src/browser/index.ts";
import type { AreaChunk } from "../../src/browser/snapshot.ts";
import { type Action, type Page, type Plan, StalePage } from "../../src/core/types.ts";
import { type Fetch, JevPolicy } from "../../src/policies/jev.ts";
import { estimateTokens } from "../../src/policies/jev-fit.ts";
import { verify as verifyCatalogDeep } from "../../tasks/catalog_deep.ts";
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

function mockChoiceAnswer(
  // biome-ignore lint/suspicious/noExplicitAny: mock Jev choice request payload.
  req: any,
  operation: string,
  matchCriterion: (criterion: unknown) => boolean,
) {
  const opKeys = Object.keys(req.questions.operation.criteria);
  const targetQuestion = `${operation.toLowerCase()}_target`;
  const criteriaEntries = Object.entries(req.questions[targetQuestion].criteria as Record<string, unknown>);
  const targetKey = criteriaEntries.find(([, criterion]) => matchCriterion(criterion))?.[0] ?? "NOT_VISIBLE";
  return {
    model: "jev-mock",
    usage: { input_tokens: 120, output_tokens: 12 },
    answers: {
      operation: {
        choice: operation,
        confidence: 0.95,
        probabilities: Object.fromEntries(opKeys.map((k) => [k, k === operation ? 1 : 0])),
      },
      [targetQuestion]: {
        choice: targetKey,
        confidence: 0.95,
        probabilities: Object.fromEntries(criteriaEntries.map(([k]) => [k, k === targetKey ? 1 : 0])),
      },
    },
  };
}

test("end-to-end scored context selects and executes deep card 420 on catalog_deep.html", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  const url = pathToFileURL(join(ROOT, "tasks", "fixtures", "catalog_deep.html")).href;
  const instance = await open(url, { whole: true, areas: true });
  const page = await instance.observe();

  const areas = areasOf(page);
  expect(areas.length).toBeGreaterThan(5);
  const targetAction = page.actions.find((a: Action) => a.label === "Add Sage Cushion 420 to cart");
  expect(targetAction).toBeDefined();
  expect(targetAction.area).toBeTruthy();
  expect(page.guards[String(targetAction.node)]).toBeTruthy();

  // biome-ignore lint/suspicious/noExplicitAny: inspect packed choose request.
  const chooseRequests: any[] = [];
  const fetch: Fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    if (req.questions.operation) {
      chooseRequests.push(req);
      return {
        status: 200,
        json: async () =>
          mockChoiceAnswer(req, "CLICK", (criterion) =>
            JSON.stringify(criterion).includes("Add Sage Cushion 420 to cart"),
          ),
      };
    }
    const answers: Record<string, { noul: number }> = {};
    for (const [key, q] of Object.entries(
      req.questions as Record<string, { instructions: { axis?: string; area?: unknown; group?: string } }>,
    )) {
      if ("group" in q.instructions) {
        const hasTarget = JSON.stringify(q.instructions).includes("Sage Cushion 420");
        answers[key] = { noul: hasTarget ? 0.95 : 0.05 };
      } else {
        const hasTarget = JSON.stringify(q.instructions.area ?? "").includes("Sage Cushion 420");
        answers[key] = { noul: q.instructions.axis === "act" && hasTarget ? 0.95 : 0.05 };
      }
    }
    return {
      status: 200,
      json: async () => ({ model: "jev-mock", usage: { input_tokens: 60, output_tokens: 6 }, answers }),
    };
  };

  const policy = new JevPolicy({ fetch });
  const plan: Plan = {
    goal: "Add Sage Cushion 420 to cart",
    steps: [{ actor: "jev", instruction: "Click Add Sage Cushion 420 to cart" }],
    values: [],
    flow: "v2",
    context: "scored",
  };

  const decision = await policy.choose(page, plan, []);
  expect(policy.calls.some((c) => c.purpose === "context_score")).toBe(true);
  expect(policy.calls.some((c) => c.purpose === "choose")).toBe(true);
  expect(policy.calls.filter((c) => c.purpose === "context_score").length).toBeLessThanOrEqual(3);
  const chooseCall = policy.calls.find((c) => c.purpose === "choose");
  expect(chooseCall?.dropped_elements ?? 0).toBe(0);
  expect(chooseRequests).toHaveLength(1);
  expect(chooseRequests[0].state.page.areas.length).toBeLessThanOrEqual(25);
  expect(chooseRequests[0].state.page.areas.some((a: { id: string }) => a.id === "_omitted")).toBe(true);
  expect(estimateTokens(JSON.stringify(chooseRequests[0]))).toBeLessThanOrEqual(24_000);
  expect(policy.events?.at(-1)?.fields).toMatchObject({ hierarchical: true, fallback: false });
  expect(decision.context_areas).toBeDefined();
  expect(decision.context_areas?.shown).toBeLessThan(decision.context_areas?.total ?? 0);
  expect(decision.operation).toBe("CLICK");
  expect(decision.action?.label).toBe("Add Sage Cushion 420 to cart");

  await instance.act(decision.action as Action, page);
  const verdict = await verifyCatalogDeep(instance);
  expect(verdict.success).toBe(true);
});

test("end-to-end scored context packs bottom appendix text and top form separately on long_doc_answer.html", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  const url = pathToFileURL(join(ROOT, "tasks", "fixtures", "long_doc_answer.html")).href;
  const instance = await open(url, { whole: true, areas: true });
  const page = await instance.observe();

  const areas = areasOf(page);
  expect(areas.length).toBeGreaterThan(8);

  // biome-ignore lint/suspicious/noExplicitAny: inspect packed choose request.
  const chooseRequests: any[] = [];
  const fetch: Fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    if (req.questions.operation) {
      chooseRequests.push(req);
      return {
        status: 200,
        json: async () => mockChoiceAnswer(req, "CLICK", (criterion) => JSON.stringify(criterion).includes("Submit")),
      };
    }
    const answers: Record<string, { noul: number }> = {};
    for (const [key, q] of Object.entries(
      req.questions as Record<string, { instructions: { axis?: string; area?: { kind?: string }; group?: string } }>,
    )) {
      if ("group" in q.instructions) {
        const raw = JSON.stringify(q.instructions);
        const keep = q.instructions.group === "form" || raw.includes("AUD-7492-QM") || raw.includes("Table 20");
        answers[key] = { noul: keep ? 0.95 : 0.05 };
      } else {
        const areaJson = JSON.stringify(q.instructions.area ?? "");
        const isForm = q.instructions.area?.kind === "form" || areaJson.includes("Confirmation code");
        const isAppendix = areaJson.includes("AUD-7492-QM");
        let score = 0.05;
        if (q.instructions.axis === "act" && isForm) score = 0.95;
        if (q.instructions.axis === "info" && isAppendix) score = 0.95;
        answers[key] = { noul: score };
      }
    }
    return {
      status: 200,
      json: async () => ({ model: "jev-mock", usage: { input_tokens: 60, output_tokens: 6 }, answers }),
    };
  };

  const policy = new JevPolicy({ fetch });
  const plan: Plan = {
    goal: "Read the final confirmation code from the appendix and submit it in the top form",
    steps: [{ actor: "jev", instruction: "Enter confirmation code and submit" }],
    values: [{ label: "code", value: "AUD-7492-QM" }],
    flow: "v2",
    context: "scored",
  };

  const decision = await policy.choose(page, plan, []);
  expect(chooseRequests).toHaveLength(1);
  const packedState = chooseRequests[0].state;
  expect(String(packedState.page.text)).toContain("AUD-7492-QM");
  expect(packedState.elements.some((el: { label: string }) => el.label === "Confirmation code")).toBe(true);
  expect(Array.isArray(packedState.page.areas)).toBe(true);
  expect(packedState.page.areas.length).toBeLessThanOrEqual(25);
  expect(packedState.page.areas.some((a: { id: string; shown: boolean }) => a.id === "_omitted" && !a.shown)).toBe(
    true,
  );
  expect(packedState.page.areas.some((a: { shown: boolean }) => !a.shown)).toBe(true);
  expect(decision.operation).toBe("CLICK");
  expect(decision.action?.label).toBe("Submit");
});
