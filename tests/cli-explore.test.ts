import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import { cli, cliExit, readEvents } from "./helpers.ts";
import { isolate, ScriptedJev } from "./jev.ts";

let log: string;
let cleanup: () => Promise<void>;
let server: Server;
let host: string;

const PAGE = `<!doctype html><title>Shop</title>
<button onclick="fetch('/api/cart').then(r => document.body.dataset.cart = r.status)">Load cart</button>
<button onclick="console.error('cart total is NaN')">Show total</button>
<button onclick="setTimeout(() => { throw new Error('boom') }, 0)">Apply coupon</button>
<a href="http://127.0.0.1:__PORT__/secret">Partner site</a>`;

beforeEach(async () => {
  ({ log, cleanup } = isolate());
  server = createServer((request, response) => {
    if (request.url === "/api/cart") {
      response.writeHead(500).end("boom");
    } else if (request.url === "/secret") {
      response.writeHead(200, { "content-type": "text/html" }).end("<title>secret</title>");
    } else {
      response.writeHead(200, { "content-type": "text/html" }).end(PAGE.replace("__PORT__", String(port())));
    }
  });
  await new Promise<void>((done) => server.listen(0, "localhost", done));
  host = `localhost:${port()}`;
});

afterEach(async () => {
  await cleanup();
  await new Promise((done) => server.close(done));
});

const port = () => (server.address() as AddressInfo).port;

const begin = (...more: string[]) =>
  cli("start", "--goal", "Look for faults", "--url", `http://${host}/`, "--chrome", "linux", ...more);

test("exploring notes a 5xx, a console error and an uncaught error, and refuses a host outside the list", async () => {
  const started = await begin("--explore", "--allow-domain", host, "--max-total-actions", "6");
  expect(started.out).toContain(
    `EXPLORING: requests to hosts other than ${host} are refused while a webhand command is running; not between commands, nor for WebSocket connections or redirects followed by a worker an earlier command started. At most 6 actions in all.`,
  );
  ScriptedJev.moves = [
    ["CLICK", "Load cart", null],
    ["CLICK", "Show total", null],
    ["CLICK", "Apply coupon", null],
  ];
  // Three clicks that change nothing on the page end the attempt as STUCK, as in any session; Claude goes on with act.
  expect((await cli("run")).out).toContain("OUTCOME STUCK");
  await cli("act", "CLICK", "4");
  const found = await cli("findings");
  expect(found.code).toBe(9);
  expect(found.out).toContain("FINDINGS:");
  expect(found.out).toMatch(/http_5xx {2}[^ ]+\/api\/cart {2}status 500/);
  expect(found.out).toContain("console_error");
  expect(found.out).toContain("cart total is NaN");
  expect(found.out).toContain("pageerror");
  expect(found.out).toContain("out_of_scope");
  expect(found.out).toContain("STEPS:");
  const events = readEvents(log).filter((e) => e.type === "finding");
  expect(events.length).toBeGreaterThan(3);
  expect(JSON.stringify(events)).not.toContain("?");
  await cli("finish", "--status", "abandoned");
});

test("a session that is not exploring has no findings", async () => {
  await begin();
  expect(await cliExit("findings")).toContain("not exploring");
  await cli("finish", "--status", "abandoned");
});

test("exploring keeps to a test environment", async () => {
  const start = (...more: string[]) =>
    cliExit("start", "--goal", "g", "--url", `http://${host}/`, "--chrome", "linux", ...more);
  const explore = ["--explore", "--allow-domain", host];
  expect(await start(...explore)).toContain("--max-total-actions");
  expect(await start("--explore", "--max-total-actions", "3")).toContain("--allow-domain HOST");
  expect(await start(...explore, "--max-total-actions", "3", "--session", "profile:x")).toContain("saved profile");
  expect(await start("--explore", "--allow-domain", "other.test", "--max-total-actions", "3")).toContain(
    "outside --allow-domain",
  );
  expect(await start("--explore", "--allow-domain", "https://x.test", "--max-total-actions", "3")).toContain(
    "takes a host",
  );
  expect(await start("--allow-domain", host)).toContain("are for --explore");
});

test("the session-wide action limit stops further runs", async () => {
  await begin("--explore", "--allow-domain", host, "--max-total-actions", "1");
  ScriptedJev.moves = [
    ["CLICK", "Show total", null],
    ["CLICK", "Load cart", null],
  ];
  await cli("run");
  expect(session_actions()).toBe(1);
  const again = await cli("run");
  expect(again.code).toBe(5);
  expect(again.out).toContain("BUDGET EXHAUSTED for this exploring session");
  await cli("finish", "--status", "abandoned");
});

import { executed } from "../src/agent/index.ts";
import * as session from "../src/storage/session.ts";

function session_actions(): number {
  return executed(session.load()?.history ?? []).length;
}
