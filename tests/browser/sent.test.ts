/** Browser.sentRequest on real Chrome: a save is told apart from a press that only reads or does nothing. */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { Browser } from "../../src/browser/index.ts";
import type { Action } from "../../src/core/types.ts";

let server: Server | undefined;
let browser: Browser | undefined;

afterEach(async () => {
  await browser?.close();
  server?.close();
});

const HTML = `<!doctype html><meta charset=utf-8><body>
<button onclick="fetch('/save', { method: 'POST' })">Save</button>
<button onclick="fetch('/data')">Load</button>
<button onclick="void 0">Count</button>`;

test("only a press that sends a request that is not a read counts", async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" }).end(HTML);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  browser = await Browser.open(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  const sent: [string, boolean][] = [];
  for (const label of ["Save", "Load", "Count"]) {
    const page = await browser.observe();
    const action = (page.actions as Action[]).find((one) => one.kind === "click" && one.label === label) as Action;
    await browser.act(action, page);
    await browser.observe();
    sent.push([label, await browser.sentRequest()]);
  }
  expect(sent).toEqual([
    ["Save", true],
    ["Load", false],
    ["Count", false],
  ]);
});
