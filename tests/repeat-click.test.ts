/**
 * The shape of WebArena task 491 on real Chrome: a save the server refuses without a word on the page, a menu opened
 * and closed, and the save chosen again. The choices are scripted, so only the browser and the loop are under test.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runAgent } from "../src/agent/index.ts";
import { REPEATED_CLICK } from "../src/agent/outcomes.ts";
import { Browser } from "../src/browser/index.ts";
import { Recorder } from "../src/core/metrics.ts";
import { type Action, Decision, type Page, type Policy } from "../src/core/types.ts";
import { readEvents, tmpPath } from "./helpers.ts";

let server: Server | undefined;
let browser: Browser | undefined;

afterEach(async () => {
  await browser?.close();
  server?.close();
});

const HTML = `<!doctype html><meta charset=utf-8><title>Order</title><body>
<button onclick="menu.hidden = false">System Messages</button>
<div id="menu" hidden><p>One message</p><button onclick="menu.hidden = true">Close</button></div>
<textarea aria-label="Comment">ready</textarea>
<button onclick="fetch('/comment', { method: 'POST', body: 'ready' })">Submit Comment</button>`;

/** Chooses the click with each label in turn, then DONE. */
function scripted(labels: string[]): Policy {
  const left = [...labels];
  return {
    name: "scripted",
    calls: [],
    config: () => ({}),
    async choose(page: Page) {
      const label = left.shift();
      if (!label) return new Decision("DONE");
      const action = (page.actions as Action[]).find((one) => one.kind === "click" && one.label === label);
      if (!action) throw new Error(`No click named ${label}`);
      return new Decision("CLICK", action);
    },
  };
}

test("a refused save is sent once, though a menu was opened and closed before it was chosen again", async () => {
  let saves = 0;
  server = createServer((request, response) => {
    if (request.method === "POST") {
      saves += 1;
      response.writeHead(200, { "content-type": "application/json" }).end('{"error":true}');
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end(HTML);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  browser = await Browser.open(`http://127.0.0.1:${(server.address() as AddressInfo).port}/order`);
  const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
  const policy = scripted(["Submit Comment", "System Messages", "Close", "Submit Comment"]);

  const result = await runAgent(browser, policy, { goal: "g", steps: [], values: [] }, recorder);
  recorder.close();

  expect(result.outcome).toBe("STUCK");
  expect(result.detail).toBe(REPEATED_CLICK);
  expect(saves).toBe(1);
  const events = readEvents(recorder.path);
  // The save left the page as it was, and the menu did change it: the case the guard has to hold through.
  expect(events.filter((x) => x.type === "step_result").map((x) => x.page_changed)).toEqual([false, true, true]);
  expect(events.filter((x) => x.type === "repeat_refused")).toHaveLength(1);
});
