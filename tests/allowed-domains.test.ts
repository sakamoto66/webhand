/** Tests for service.toml `allowed_domains` enforcement across catalog, start, replan, answer, and live Chrome navigations. */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deps, FAILED, OK } from "../src/commands/context.ts";
import { engineFor } from "../src/engines/index.ts";
import { which } from "../src/engines/process.ts";
import { RemoteBrowser } from "../src/ipc/remote.ts";
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

  const cat = await cli("catalog", "--chrome", "linux");
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

/** A service whose runs must stay on one host, `app.test` unless given. */
function boundedService(host = "app.test"): void {
  writeService(
    "bounded",
    [
      'service = "bounded"',
      'description = "Bounded"',
      `base_url = "http://${host}/"`,
      `allowed_domains = ["${host}"]`,
      "",
    ].join("\n"),
  );
}

const UNENFORCED = [
  ["obscura", "Obscura"],
  ["browser-run", "Cloudflare Browser Run"],
  ["kitesurf", "Cloudflare Browser Run (Kitesurf)"],
];

test.each(UNENFORCED)("%s refuses a run with allowed_domains before its browser starts", async (engine, label) => {
  boundedService();
  const startChrome = vi.fn(async () => {
    throw new Error("the browser must not start");
  });
  deps.startChrome = startChrome;
  const refused = await cliExit(
    "start",
    "--engine",
    engine,
    "--service",
    "bounded",
    "--goal",
    "Open page",
    "--url",
    "http://app.test/",
  );
  expect(refused).toBe(
    `${label} cannot enforce service bounded's allowed_domains. Use --engine chrome, headless-shell or lightpanda`,
  );
  expect(startChrome).not.toHaveBeenCalled();
});

test.each(UNENFORCED)("%s refuses replan --service that adds allowed_domains", async (engine, label) => {
  boundedService();
  session.save({
    engine,
    state_version: 1,
    start_url: "http://app.test/",
    page: { url: "http://app.test/" },
    plan: { goal: "g", steps: [], values: [], notes: [], attempt: 1, service: null },
    outcome: null,
    outcomes: [],
    max_attempts: 3,
    attempt_unused: true,
    log: join(process.env.WEBHAND_HOME as string, "run.jsonl"),
  } as unknown as session.State);
  const rejected = await cli("replan", "--reason", "add the service", "--service", "bounded");
  expect(rejected.code).toBe(FAILED);
  expect(rejected.out).toContain(
    `REJECTED: ${label} cannot enforce service bounded's allowed_domains. Use --engine chrome, headless-shell or lightpanda`,
  );
  expect(session.load()?.allowed_domains).toBeUndefined();
  expect(session.load()?.service).toBeUndefined();
});

test.each(UNENFORCED)("%s does not attach to a saved session that has allowed_domains", async (engine, label) => {
  const state = { engine, socket: "/nonexistent", allowed_domains: ["app.test"] } as unknown as session.State;
  await expect(engineFor(engine).attach(state, null)).rejects.toThrow(`${label} cannot enforce allowed_domains`);
});

const NO_LIGHTPANDA = which("lightpanda") === null;

/** An allowed site and a site outside it, which counts every request that reaches it as a page. */
async function twoSites() {
  const reached: string[] = [];
  const evil = await startServer((url, res) => {
    reached.push(url);
    res.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" });
    res.end(url === "/lib.js" ? "document.title = 'lib'" : "<h1>Evil Site</h1>");
  });
  const out = `http://127.0.0.1:${evil}`;
  const port = await startServer((url, res) => {
    const status = /^\/status\/(\d+)$/.exec(url)?.[1];
    if (url === "/redir" || status) {
      res.writeHead(Number(status ?? 302), { Location: `${out}/redirected` });
      res.end();
      return;
    }
    if (url === "/chain" || url === "/inside") {
      res.writeHead(302, { Location: url === "/chain" ? "/redir" : "/landed" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html",
      ...(url === "/refresh" ? { Refresh: `0;url=${out}/header` } : {}),
    });
    if (url === "/meta") res.end(`<meta http-equiv="refresh" content="0;url=${out}/meta">`);
    else if (url === "/landed") res.end("<title>Landed</title><h1>Landed</h1>");
    else if (url === "/script") res.end(`<title>Script</title><script src="${out}/lib.js"></script><p>text</p>`);
    else {
      res.end(
        `<title>Home</title><h1>Allowed Home</h1><p><a href="${out}/link">Leave site</a></p>` +
          `<p><a href="/redir">Bounce</a></p><p><a href="${out}/blank" target="_blank">New window</a></p>`,
      );
    }
  });
  return { home: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, out, reached };
}

const startBounded = (url: string, ...extra: string[]) =>
  cli("start", "--engine", "lightpanda", "--goal", "Stay", "--url", url, "--step", "Wait", ...extra);

/** Presses the link with this label, as the CLI observed it. */
async function press(label: string): Promise<void> {
  const seen = await cli("observe");
  const index = new RegExp(`\\[\\s*(\\d+)\\s*\\][^\\n]*${label}`).exec(seen.out)?.[1];
  expect(index, seen.out).toBeTruthy();
  await cli("act", "CLICK", index as string);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 400));

test.skipIf(NO_LIGHTPANDA)("lightpanda: clicks and redirects do not reach a host outside", async () => {
  const site = await twoSites();
  boundedService(site.host);
  const started = await startBounded(`${site.home}/`, "--service", "bounded", "--max-attempts", "9");
  expect(started.code).toBe(OK);

  for (const label of ["Leave site", "Bounce", "New window"]) {
    await press(label);
    await pause();
    expect(site.reached, label).toEqual([]);
    await cli("replan", "--reason", "go home", "--restart");
  }
  await cli("finish", "--status", "abandoned", "--reason", "test");
});

test.skipIf(NO_LIGHTPANDA)("lightpanda: a start URL that redirects outside never reaches it", async () => {
  const site = await twoSites();
  boundedService(site.host);
  await expect(startBounded(`${site.home}/redir`, "--service", "bounded")).rejects.toThrow("ERR_BLOCKED_BY_CLIENT");
  expect(site.reached).toEqual([]);
  expect(session.load()).toBeNull();
});

test.skipIf(NO_LIGHTPANDA)(
  "lightpanda: replan --service guards the session, between commands too, and leaves the allowed site as it was",
  async () => {
    const site = await twoSites();
    boundedService(site.host);
    expect((await startBounded(`${site.home}/`)).code).toBe(OK);
    expect((await cli("replan", "--reason", "bound it", "--service", "bounded")).code).toBe(OK);

    // The page's own navigations, started by one connection and finished after it ended.
    const triggers = [
      ...[301, 302, 303, 307, 308].map((status) => `location.href = '/status/${status}'`),
      "location.href = '/chain'",
      "location.href = '/meta'",
      "location.href = '/refresh'",
      `location.replace('${site.out}/replace')`,
      `void setTimeout(() => { location.href = '${site.out}/timer' }, 100)`,
      `void window.open('${site.out}/open')`,
      "void window.open('/redir')",
      `const g = document.createElement('form'); g.action = '${site.out}/get'; document.body.append(g); g.submit()`,
      `const p = document.createElement('form'); p.method = 'post'; p.action = '/redir'; document.body.append(p); p.submit()`,
      `const i = document.createElement('iframe'); i.src = '${site.out}/iframe'; document.body.append(i)`,
    ];
    const socket = session.load()?.socket as string;
    for (const trigger of triggers) {
      const first = await RemoteBrowser.connect(socket);
      await first.goto(`${site.home}/`);
      await first.evaluate(`{ ${trigger} }`);
      await first.close();
      await pause();
      expect(site.reached, trigger).toEqual([]);
    }

    // As in Chrome: a redirect inside the list is followed, and what is not a page navigation is not held back.
    const browser = await RemoteBrowser.connect(socket);
    await browser.goto(`${site.home}/inside`);
    expect((await browser.observe()).title).toBe("Landed");
    await expect(browser.goto(`${site.home}/redir`)).rejects.toThrow("ERR_BLOCKED_BY_CLIENT");
    expect(site.reached).toEqual([]);
    await browser.goto(`${site.home}/script`);
    await pause();
    expect(site.reached).toEqual(["/lib.js"]);
    await browser.close();
    await cli("finish", "--status", "abandoned", "--reason", "test");
  },
);
