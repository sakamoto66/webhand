/** A tab that never loads times the next connection out. It is closed, once, and the command connects again. */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { connectLimit } from "../../src/browser/connect.ts";
import { Browser } from "../../src/browser/index.ts";
import { newTabLimit } from "../../src/browser/tabs.ts";
import { main } from "../../src/cli.ts";
import { OK } from "../../src/commands/context.ts";
import * as session from "../../src/storage/session.ts";
import { cli, readEvents } from "../helpers.ts";
import { isolate, ScriptedJev } from "../jev.ts";

/**
 * For a connection that a stuck tab is to time out: it ends the same way however short, so it is short. Every other
 * connection, the one made after closing included, keeps the product's own limit.
 */
const BLOCKED_MS = 2000;
/** Long enough that only a blocked connection runs into it, on a loaded machine too. */
const UNTOLD_MS = 8000;
/** A stuck tab only has to be opened here; tests/browser/new-tab.test.ts covers the wait for it. */
const STUCK_WAIT_MS = 500;
const usual = { connect: connectLimit.ms, newTab: newTabLimit.ms };
let server: Server;
let base: string;
let presses = 0;
let log: string;
let cleanup: () => Promise<void>;

const DESK = `<title>Event desk</title>
<a href="/other" target="_blank">Open other</a>
<a href="/empty" target="_blank">Open empty</a>
<a href="/silent?token=secret" target="_blank">Open silent</a>
<button onclick="fetch('/press', { method: 'POST' }); this.textContent = 'Pressed'">Press</button>`;

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    if (path === "/silent") return;
    if (path === "/empty") return void response.writeHead(204).end();
    if (path === "/press") presses += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(path === "/" ? DESK : "<title>Other</title><p>Other page</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  ({ log, cleanup } = isolate());
  presses = 0;
});

afterEach(async () => {
  connectLimit.ms = usual.connect;
  newTabLimit.ms = usual.newTab;
  await cleanup();
});

/** Runs the CLI, keeping what it writes to stderr too. */
async function webhand(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  return { code, out, err };
}

/** `act CLICK` on the control with this name in the last observation. */
async function press(name: string) {
  const { out } = await cli("observe");
  const target = out.match(new RegExp(`\\[(\\d+)\\] \\w+ "${name}"`))?.[1];
  expect(target).toBeDefined();
  return webhand("act", "CLICK", target as string);
}

/** Opens a tab that never loads, then leaves the next connection to run into it. */
async function openStuck(kind: "empty" | "silent") {
  const { out } = await cli("observe");
  const target = out.match(new RegExp(`\\[(\\d+)\\] link "Open ${kind}"`))?.[1] as string;
  newTabLimit.ms = STUCK_WAIT_MS;
  expect((await webhand("act", "CLICK", target)).code).toBe(OK);
  newTabLimit.ms = usual.newTab;
  connectLimit.ms = BLOCKED_MS;
}

/** One command that has to connect again; those after it have the product's limit. */
async function reconnecting(...argv: string[]) {
  const result = await webhand(...argv);
  connectLimit.ms = usual.connect;
  return result;
}

async function begin(): Promise<void> {
  const { code } = await cli("start", "--url", `${base}/`, "--goal", "probe", "--chrome", "linux");
  expect(code).toBe(OK);
}

async function tabUrls(): Promise<string[]> {
  const response = await fetch(`http://127.0.0.1:${session.load()?.port}/json/list`);
  const targets = (await response.json()) as { type: string; url: string }[];
  return targets.filter((t) => t.type === "page").map((t) => new URL(t.url || "about:none").pathname);
}

test.each(["empty", "silent"])("after a tab that never loads (%s), the next command connects again", async (kind) => {
  await begin();
  await press("Open other");
  await openStuck(kind as "empty" | "silent");

  const next = await reconnecting("observe");
  expect(next.code).toBe(OK);
  expect(next.err).toBe("NOTE: closed 1 tab that never loaded, to reconnect to the browser. Nothing was repeated.\n");
  expect(next.out).not.toContain("never loaded");
  expect(next.out).toContain("TABS: 2 open"); // The tab that loaded is kept.
  expect((await tabUrls()).sort()).toEqual(["/", "/other"]);
  const closed = readEvents(log).filter((e) => e.type === "stuck_tabs_closed");
  expect(closed).toEqual([{ type: "stuck_tabs_closed", count: 1 }]);

  // Nothing is said, and nothing is slow, once the tab is gone.
  expect((await webhand("observe")).err).toBe("");
});

test("an action that is the first command after a stuck tab runs exactly once", async () => {
  await begin();
  const { out } = await cli("observe");
  const button = out.match(/\[(\d+)\] button "Press"/)?.[1] as string;
  await openStuck("silent");

  const acted = await reconnecting("act", "CLICK", button);
  expect(acted.code).toBe(OK);
  expect(acted.err).toContain("closed 1 tab that never loaded");
  expect(acted.out).toContain('"Pressed"');
  expect(presses).toBe(1);
});

test("run connects again before Jev's first action", async () => {
  await begin();
  await openStuck("silent");
  ScriptedJev.moves = [
    ["CLICK", "Press", null],
    ["DONE", null, null],
  ];
  const ran = await reconnecting("run");
  expect(ran.code).toBe(OK);
  expect(ran.err).toContain("closed 1 tab that never loaded");
  expect(ran.out).toContain("OUTCOME GOAL_REPORTED");
  expect(presses).toBe(1);
});

test("a saved profile connects again, finishes, and starts again", async () => {
  // Only Chrome keeps a saved profile.
  const start = ["start", "--url", `${base}/`, "--goal", "probe", "--chrome", "linux", "--engine", "chrome"];
  expect((await cli(...start, "--session", "profile:stuck")).code).toBe(OK);
  await openStuck("silent");
  const next = await reconnecting("observe");
  expect(next.code).toBe(OK);
  expect(next.err).toContain("closed 1 tab that never loaded");
  await openStuck("silent");
  connectLimit.ms = usual.connect;
  expect((await cli("finish", "--status", "done")).code).toBe(OK);
  const again = await webhand(...start, "--session", "profile:stuck");
  expect(again.code).toBe(OK);
  expect(again.out).toContain("TITLE: Event desk");
});

test("without being asked to, a connection closes no tab", async () => {
  await begin();
  await openStuck("silent");
  connectLimit.ms = UNTOLD_MS;
  const port = session.load()?.port as number;
  await expect(Browser.open(null, { port })).rejects.toThrow(/Timeout/);
  expect(await tabUrls()).toHaveLength(2);
});

test("a connection that times out with every tab loaded stays failed and closes nothing", async () => {
  await begin();
  await press("Open other");
  const port = session.load()?.port as number;
  connectLimit.ms = 1;
  let told = 0;
  await expect(Browser.open(null, { port, onStuckTabsClosed: () => told++ })).rejects.toThrow(/Timeout/);
  expect(told).toBe(0);
  expect((await tabUrls()).sort()).toEqual(["/", "/other"]);
});
