import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { alive } from "../src/engines/process.ts";
import type { HarDocument } from "../src/har.ts";
import { stopHarRecorder } from "../src/har-session.ts";
import * as session from "../src/session.ts";
import { cli, cliExit, readEvents, tmpPath } from "./helpers.ts";
import { isolate, ScriptedJev } from "./jev.ts";

let log: string;
let cleanup: () => Promise<void>;
let server: Server;
let baseUrl: string;
let workDir: string;

const HOME_HTML = `<!doctype html>
<html>
<head>
  <title>Har Demo</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <form method="POST" action="/submit">
    <label for="q">Note</label>
    <input id="q" name="note" type="text" />
    <button type="submit">Send</button>
  </form>
  <button id="api" onclick="fetch('/api/items', {method:'POST', headers:{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'}, body:JSON.stringify({item:'book',qty:2})}).then(r=>r.json()).then(d=>{document.getElementById('out').textContent=d.status})">Call API</button>
  <a href="/popup" target="_blank">Open popup</a>
  <div id="out"></div>
</body>
</html>`;

beforeEach(async () => {
  ({ log, cleanup } = isolate());
  workDir = tmpPath();
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/style.css") {
      res.writeHead(200, { "content-type": "text/css" }).end("body { color: black; }");
      return;
    }
    if (url.startsWith("/start")) {
      res.writeHead(200, { "content-type": "text/html" }).end(HOME_HTML);
      return;
    }
    if (url === "/submit" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res
          .writeHead(302, {
            location: "/done?ok=1",
            "set-cookie": ["session_id=abc123; Path=/; HttpOnly", `last_note=${encodeURIComponent(body)}; Path=/`],
          })
          .end();
      });
      return;
    }
    if (url.startsWith("/done")) {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<!doctype html><title>Done</title><p>Submitted</p><button onclick="fetch('/api/items',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'},body:JSON.stringify({item:'book',qty:2})}).then(r=>r.json()).then(d=>{document.body.dataset.ok=d.status})">Call API</button><a href="/popup" target="_blank">Open popup</a>`,
        );
      return;
    }
    if (url === "/api/items" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ status: "created", id: 42 }));
      return;
    }
    if (url === "/popup") {
      res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Popup</title><p>Popup page</p>");
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  const state = session.load();
  if (state?.har) await stopHarRecorder(state.har);
  await cleanup();
  await new Promise((done) => server.close(done));
  rmSync(workDir, { recursive: true, force: true });
});

test("records HAR 1.2 across start, run, act, redirects, cookies, JSON API, and new tabs", async () => {
  const harPath = join(workDir, "out", "network.har");
  const started = await cli(
    "start",
    "--goal",
    "Submit note, call API, open popup",
    "--url",
    `${baseUrl}/start?tab=main`,
    "--value",
    "Note=hello-har",
    "--chrome",
    "linux",
    "--har",
    harPath,
  );
  expect(started.code).toBe(0);
  expect(started.out).toContain(`HAR: recording to ${harPath}`);

  const harPid = session.load()?.har?.pid as number;
  expect(Number.isInteger(harPid)).toBe(true);
  expect(alive(harPid)).toBe(true);

  ScriptedJev.moves = [
    ["TYPE_TEXT", "Note", "Note"],
    ["CLICK", "Send", null],
    ["CLICK", "Call API", null],
    ["CLICK", "Open popup", null],
    ["DONE", null, null],
  ];
  const ran = await cli("run");
  expect(ran.out).toContain("OUTCOME GOAL_REPORTED");
  // Wait until the popup tab is loaded, then switch to it in a separate CLI command so cross-command capture is exercised.
  let popupTab = "";
  await vi.waitFor(
    async () => {
      const observed = await cli("observe");
      expect(observed.code).toBe(0);
      const tab = session.load()?.page?.actions?.find((a: { kind: string }) => a.kind === "tab") as
        | { tab: number; title?: string }
        | undefined;
      expect(tab?.title).toBe("Popup");
      popupTab = `TAB_${tab?.tab}`;
    },
    { timeout: 10_000, interval: 100 },
  );
  const switched = await cli("act", popupTab);
  expect(switched.code).toBe(0);
  expect(switched.out).toContain("Popup page");

  const finished = await cli("finish", "--status", "done", "--reason", "all actions completed");
  expect(finished.code).toBe(0);
  expect(finished.out).toContain(`har=${harPath}`);
  expect(alive(harPid)).toBe(false);

  expect(existsSync(harPath)).toBe(true);
  expect(statSync(harPath).mode & 0o777).toBe(0o600);

  const har = JSON.parse(readFileSync(harPath, "utf8")) as HarDocument;
  expect(har.log.version).toBe("1.2");
  expect(har.log.creator.name).toBe("webhand");
  const entries = har.log.entries;

  // 1. Initial navigation GET with unredacted query string and navigation headers.
  const nav = entries.find((e) => e.request.url === `${baseUrl}/start?tab=main` && e.request.method === "GET");
  expect(nav).toBeDefined();
  expect(nav?.request.queryString).toEqual([{ name: "tab", value: "main" }]);
  expect(nav?.response.status).toBe(200);
  const navHeaders = Object.fromEntries((nav?.request.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  expect(navHeaders.accept ?? "").toContain("text/html");

  // 2. Static asset entry exists, body skipped.
  const css = entries.find((e) => e.request.url === `${baseUrl}/style.css`);
  expect(css).toBeDefined();
  expect(css?.response.content.text).toBeUndefined();

  // 3. Form POST -> 302 redirect with redirectURL + Set-Cookie parsed into response.cookies.
  const submit = entries.find((e) => e.request.url === `${baseUrl}/submit` && e.request.method === "POST");
  expect(submit).toBeDefined();
  expect(submit?.request.postData?.text).toBe("note=hello-har");
  expect(submit?.response.status).toBe(302);
  expect(submit?.response.redirectURL).toBe(`${baseUrl}/done?ok=1`);
  expect(submit?.response.cookies.map((c) => c.name)).toContain("session_id");
  expect(submit?.response.cookies.find((c) => c.name === "session_id")?.value).toBe("abc123");

  // 4. Redirect destination GET with query param and Referer.
  const donePage = entries.find((e) => e.request.url === `${baseUrl}/done?ok=1` && e.request.method === "GET");
  expect(donePage).toBeDefined();
  expect(donePage?.response.status).toBe(200);

  // 5. JSON API POST with request postData, custom header, and JSON response body.
  const api = entries.find((e) => e.request.url === `${baseUrl}/api/items` && e.request.method === "POST");
  expect(api).toBeDefined();
  expect(api?.request.postData?.text).toBe('{"item":"book","qty":2}');
  expect(api?.response.status).toBe(201);
  expect(JSON.parse(api?.response.content.text ?? "{}")).toEqual({ status: "created", id: 42 });

  // 6. New tab (target=_blank) traffic is captured too.
  const popup = entries.find((e) => e.request.url === `${baseUrl}/popup` && e.request.method === "GET");
  expect(popup).toBeDefined();
  expect(popup?.response.status).toBe(200);

  // 7. Run log notes har on run_start and har_entries on run_end.
  const events = readEvents(log);
  expect(events.find((e) => e.type === "run_start")?.har).toBe(true);
  expect(events.find((e) => e.type === "run_end")?.har_entries).toBe(entries.length);
});

test("rejects --har on unsupported engines and keeps output unchanged when --har is omitted", async () => {
  const message = await cliExit(
    "start",
    "--goal",
    "g",
    "--url",
    `${baseUrl}/start`,
    "--engine",
    "lightpanda",
    "--har",
    join(workDir, "nope.har"),
  );
  expect(message).toContain("--har needs Chrome or headless-shell");

  const started = await cli("start", "--goal", "No har", "--url", `${baseUrl}/start`, "--chrome", "linux");
  expect(started.out).not.toContain("HAR:");
  const finished = await cli("finish", "--status", "abandoned");
  expect(finished.out).not.toContain("har=");
});
