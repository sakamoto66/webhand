/** Tests for service.toml `allowed_domains` enforcement across catalog, start, replan, answer, and live Chrome navigations. */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FAILED, OK } from "../src/commands/context.ts";
import * as runbook from "../src/storage/runbook/index.ts";
import * as session from "../src/storage/session.ts";
import { cli, cliExit } from "./helpers.ts";
import { isolate } from "./jev.ts";

let cleanup: () => Promise<void>;
const servers: Server[] = [];

async function startServer(handler: (url: string, res: import("node:http").ServerResponse) => void): Promise<number> {
  const server = createServer((req, res) => handler(req.url ?? "/", res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

beforeEach(() => {
  ({ cleanup } = isolate());
  const emptyCwd = join(process.env.WEBHAND_HOME as string, "cwd");
  mkdirSync(emptyCwd, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(emptyCwd);
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
});

afterEach(async () => {
  await cleanup();
  while (servers.length) {
    const server = servers.pop();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function writeService(name: string, body: string): void {
  const dir = join(runbook.root("user"), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.toml"), body);
}

test("service.toml parses and validates allowed_domains and shows them in catalog", async () => {
  writeService(
    "portal",
    [
      'service = "portal"',
      'description = "Internal portal"',
      'base_url = "https://portal.example.test/"',
      'allowed_domains = ["Portal.Example.Test", "sso.example.test:8443"]',
      "",
    ].join("\n"),
  );
  const info = runbook.loadService("portal");
  expect(info?.allowed_domains).toEqual(["portal.example.test", "sso.example.test:8443"]);

  const cat = await cli("catalog");
  expect(cat.code).toBe(OK);
  expect(cat.out).toContain("allowed_domains: portal.example.test, sso.example.test:8443");

  writeService(
    "bad-domains",
    [
      'service = "bad-domains"',
      'description = "Bad"',
      'base_url = "https://example.test/"',
      'allowed_domains = ["https://example.test"]',
      "",
    ].join("\n"),
  );
  expect(() => runbook.loadService("bad-domains")).toThrow("allowed_domains takes a host");
});

test("start, replan --url, answer --url, and Chrome navigation all block hosts outside service allowed_domains", async () => {
  let evilHits = 0;
  const evilPort = await startServer((_url, res) => {
    evilHits += 1;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Evil Site</h1>");
  });
  const allowedPort = await startServer((url, res) => {
    if (url === "/redir") {
      res.writeHead(302, { Location: `http://127.0.0.1:${evilPort}/` });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>Allowed Home</h1><a href="http://127.0.0.1:${evilPort}/">Leave site</a><a href="/redir">Bounce</a>`);
  });

  writeService(
    "safe-app",
    [
      'service = "safe-app"',
      'description = "Local safe app"',
      `base_url = "http://127.0.0.1:${allowedPort}/"`,
      `allowed_domains = ["127.0.0.1:${allowedPort}"]`,
      "",
    ].join("\n"),
  );

  // start rejects an out-of-scope start URL before opening Chrome.
  const blockedStart = await cliExit(
    "start",
    "--service",
    "safe-app",
    "--goal",
    "Open page",
    "--url",
    `http://127.0.0.1:${evilPort}/`,
    "--step",
    "Wait",
    "--chrome",
    "linux",
  );
  expect(blockedStart).toContain("outside service safe-app's allowed_domains");
  expect(evilHits).toBe(0);

  // start succeeds on allowed host and prints ALLOWED DOMAINS.
  const started = await cli(
    "start",
    "--service",
    "safe-app",
    "--goal",
    "Stay on safe app",
    "--url",
    `http://127.0.0.1:${allowedPort}/`,
    "--step",
    "Wait",
    "--chrome",
    "linux",
  );
  expect(started.code).toBe(OK);
  expect(started.out).toContain(`ALLOWED DOMAINS: 127.0.0.1:${allowedPort}`);

  // Clicking a link to the disallowed host is aborted by the context route before hitting evilPort.
  const obs = await cli("observe");
  expect(obs.code).toBe(OK);
  const clickIdx = /\[\s*(\d+)\s*\][^\n]*Leave site/.exec(obs.out)?.[1];
  expect(clickIdx).toBeTruthy();
  await cli("act", "CLICK", clickIdx as string);
  expect(evilHits).toBe(0);

  // replan --url to disallowed host is rejected.
  const badReplan = await cli("replan", "--reason", "try external", "--url", `http://127.0.0.1:${evilPort}/`);
  expect(badReplan.code).toBe(FAILED);
  expect(badReplan.out).toContain("outside allowed_domains");

  // answer --url to disallowed host is rejected.
  const state = session.load();
  expect(state).not.toBeNull();
  if (state) {
    state.outcome = "ESCALATE";
    session.save(state);
  }
  const badAnswer = await cli("answer", "--note", "go elsewhere", "--url", `http://127.0.0.1:${evilPort}/`);
  expect(badAnswer.code).toBe(FAILED);
  expect(badAnswer.out).toContain("outside allowed_domains");

  const fin = await cli("finish", "--status", "done", "--reason", "stayed inside allowed_domains");
  expect(fin.code).toBe(OK);
  expect(evilHits).toBe(0);
});
