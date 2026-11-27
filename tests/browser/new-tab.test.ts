/** A tab a click opens is in the next observation, even when its server has not answered yet. */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { Browser } from "../../src/browser/index.ts";
import type { Page } from "../../src/core/types.ts";
import { find } from "./support.ts";

/** Longer than the opener's quiet time, so the click's page settles first. */
const ANSWER_MS = 600;
/** The longest wait for a new tab: an observation that waited for one takes at least this long. */
const WAIT_MS = 5000;
let server: Server;
let base: string;
let browser: Browser | null = null;

const link = (path: string) => `<title>Event desk</title><a href="${path}" target="_blank">Open guest form</a>`;
const form = "<title>Guest registration</title><label>Guest <input></label>";
const PAGES: Record<string, string> = {
  "/": link("/form"),
  "/to-empty": link("/empty"),
  "/to-silent": link("/silent"),
  "/to-file": link("/file"),
  "/post":
    '<title>Event desk</title><form action="/form" method="post" target="_blank"><button>Open guest form</button></form>',
  "/script": `<title>Event desk</title><button onclick="window.open('/form', '', 'noopener')">Open guest form</button>`,
  "/form": form,
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/silent") return;
    if (path === "/empty") return void response.writeHead(204).end();
    if (path === "/file") {
      return void response.writeHead(200, { "content-disposition": "attachment; filename=a.txt" }).end("a");
    }
    setTimeout(
      () => {
        response.writeHead(PAGES[path] ? 200 : 404, { "content-type": "text/html" });
        response.end(PAGES[path] ?? "");
      },
      path === "/form" ? ANSWER_MS : 0,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await browser?.close();
  browser = null;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** Presses the control that opens a tab, then observes once. */
async function clickAndObserve(on: Browser): Promise<{ next: Page; ms: number }> {
  const first = await on.observe();
  await on.act(
    find(first, (a) => a.label === "Open guest form"),
    first,
  );
  const started = performance.now();
  const next = await on.observe();
  return { next, ms: performance.now() - started };
}

async function timedObserve(on: Browser): Promise<number> {
  const started = performance.now();
  await on.observe();
  return performance.now() - started;
}

test.each(["/", "/post", "/script"])("the first observation after the click on %s offers the new tab", async (path) => {
  browser = await Browser.open(`${base}${path}`);
  const { next } = await clickAndObserve(browser);
  expect(next.tabs).toEqual({ count: 2, current: 1 });
  expect(find(next, (a) => a.kind === "tab")?.label).toBe("Switch to tab 2: Guest registration");
});

test.each(["/to-empty", "/to-silent"])("a tab that never loads (%s) is waited for once", async (path) => {
  browser = await Browser.open(`${base}${path}`);
  const { next, ms } = await clickAndObserve(browser);
  expect(next.tabs).toBeUndefined();
  expect(ms).toBeGreaterThanOrEqual(WAIT_MS);
  expect(await timedObserve(browser)).toBeLessThan(WAIT_MS);
});

test("a tab that closes for a download ends the wait", async () => {
  browser = await Browser.open(`${base}/to-file`);
  // Chrome closes the tab; the headless shell keeps it, empty. Neither may cost the whole wait.
  const { ms } = await clickAndObserve(browser);
  expect(ms).toBeLessThan(WAIT_MS);
});
