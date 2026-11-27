/** What `start --explore --allow-domain` refuses in a live Chrome: nothing may reach a host outside the list. */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FAILED, OK } from "../src/commands/context.ts";
import { attach } from "../src/commands/shared.ts";
import { shellProbe } from "../src/engines/headless-shell.ts";
import * as session from "../src/storage/session.ts";
import { cli, readEvents } from "./helpers.ts";
import { isolate } from "./jev.ts";

let log: string;
let cleanup: () => Promise<void>;
const servers: Server[] = [];
/** The paths that reached the host outside the list. */
let reached: string[];
let home: string;
let host: string;
let out: string;

async function listen(handler: (url: string, res: import("node:http").ServerResponse) => void): Promise<number> {
  const server = createServer((req, res) => handler(req.url ?? "/", res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

beforeEach(async () => {
  ({ log, cleanup } = isolate());
  reached = [];
  const open = { "Access-Control-Allow-Origin": "*" };
  const evil = await listen((url, res) => {
    if (url !== "/favicon.ico") reached.push(url);
    res.writeHead(200, { "Content-Type": "text/html", ...open }).end("<h1>Outside</h1>");
  });
  out = `http://127.0.0.1:${evil}`;
  const port = await listen((url, res) => {
    if (url.startsWith("/redir")) {
      res.writeHead(302, { Location: `${out}${url}`, ...open }).end();
      return;
    }
    if (url === "/inside") {
      res.writeHead(302, { Location: "/landed" }).end();
      return;
    }
    if (url === "/sw.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end("self.addEventListener('message', () => fetch('/redir-worker-message').catch(() => {}))");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    if (url === "/first") {
      res.end(
        `<img src="${out}/first-image"><img src="/redir-first-image"><script>fetch('/redir-first-fetch').catch(() => {})</script>`,
      );
    } else if (url === "/meta") res.end(`<meta http-equiv="refresh" content="0;url=${out}/meta">`);
    else if (url === "/sub") {
      res.end(
        `<img src="/redir-tab-image"><script src="/redir-tab-script"></script><iframe src="/redir-tab-frame"></iframe>`,
      );
    } else if (url === "/framed") res.end(`<iframe src="http://localhost:${port}/child"></iframe>`);
    else if (url === "/child")
      res.end("<script>onmessage = () => fetch('/redir-frame-fetch').catch(() => {})</script>");
    else if (url === "/landed") res.end("<title>Landed</title><h1>Landed</h1>");
    else res.end(`<title>Home</title><h1>Home</h1><p><a href="/redir-link">Bounce</a></p>`);
  });
  host = `127.0.0.1:${port}`;
  home = `http://${host}`;
});

afterEach(async () => {
  await cleanup();
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

const pause = () => new Promise((resolve) => setTimeout(resolve, 500));

describe.each([
  { engine: "chrome", missing: false },
  { engine: "headless-shell", missing: shellProbe.binary() === null },
])("$engine", ({ engine, missing }) => {
  const explore = (url: string) =>
    cli(
      ...["start", "--engine", engine, "--chrome", "linux", "--goal", "Look for faults", "--step", "Wait"],
      ...["--url", url, "--explore", "--allow-domain", host, "--allow-domain", host.replace("127.0.0.1", "localhost")],
      ...["--max-total-actions", "9", "--max-attempts", "9"],
    );
  const finish = () => cli("finish", "--status", "abandoned", "--reason", "test");

  test.skipIf(missing)("a start URL that redirects outside never reaches it", async () => {
    await expect(explore(`${home}/redir-start`)).rejects.toThrow("ERR_BLOCKED_BY_CLIENT");
    expect(reached).toEqual([]);
    expect(session.load()).toBeNull();
  });

  test.skipIf(missing).each(["/first", "/meta"])("the first load of %s stays inside", async (path) => {
    expect((await explore(`${home}${path}`)).code).toBe(OK);
    await pause();
    expect(reached).toEqual([]);
    await finish();
  });

  test.skipIf(missing)("replan --url and answer --url stay inside", async () => {
    expect((await explore(`${home}/`)).code).toBe(OK);
    const listed = `outside --allow-domain (${host}, ${host.replace("127.0.0.1", "localhost")})`;
    const replanned = await cli("replan", "--reason", "leave", "--url", `${out}/replan`);
    expect(replanned.code).toBe(FAILED);
    expect(replanned.out).toContain(`REJECTED: --url is ${listed}`);
    const state = session.load() as session.State;
    session.save({ ...state, outcome: "ESCALATE" });
    const answered = await cli("answer", "--note", "leave", "--url", `${out}/answer`);
    expect(answered.code).toBe(FAILED);
    expect(answered.out).toContain(`REJECTED: --url is ${listed}`);
    await expect(cli("replan", "--reason", "bounce", "--url", `${home}/redir-replan`)).rejects.toThrow(
      "ERR_BLOCKED_BY_CLIENT",
    );
    expect(reached).toEqual([]);
    await finish();
  });

  test.skipIf(missing)("no redirect leaves, on a page an earlier command opened or in a new tab", async () => {
    expect((await explore(`${home}/`)).code).toBe(OK);
    const connect = () => attach(session.load() as session.State, null);
    const cases: [string, string][] = [
      ["/", "location.href = '/redir-nav'"],
      ["/", "void fetch('/redir-fetch').catch(() => {})"],
      ["/", "void (new Image().src = '/redir-image')"],
      ["/", "void navigator.sendBeacon('/redir-beacon', 'x')"],
      ["/", "void window.open('/redir-tab', '_blank', 'noopener')"],
      ["/", "void window.open('/sub', '_blank', 'noopener')"],
      ["/", "location.href = '/sub'"],
      ["/", "void window.w.postMessage(1)"],
      ["/", `void new Worker(URL.createObjectURL(new Blob(["fetch('${home}/redir-worker').catch(() => {})"])))`],
      [
        "/",
        "void navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then((r) => r.active.postMessage(1))",
      ],
      ["/framed", "frames[0].postMessage(1, '*')"],
      ["/", "const f = document.createElement('iframe'); f.src = '/framed'; document.body.append(f)"],
    ];
    for (const [path, trigger] of cases) {
      const earlier = await connect();
      await earlier.goto?.(`${home}${path}`);
      // A worker that was already running when the command connected.
      if (trigger.includes("window.w")) {
        await earlier.evaluate(
          `window.w = new Worker(URL.createObjectURL(new Blob(["onmessage = () => fetch('${home}/redir-old-worker').catch(() => {})"])))`,
        );
        await pause();
      }
      await earlier.close();
      const browser = await connect();
      await browser.evaluate(`{ ${trigger} }`);
      await pause();
      await browser.close();
      expect(reached, trigger).toEqual([]);
    }
    const browser = await connect();
    await browser.goto?.(`${home}/inside`);
    expect((await browser.observe()).title).toBe("Landed");
    await browser.close();
    await finish();
  });

  test.skipIf(missing)("a refused redirect is noted as out_of_scope, not as a failed request", async () => {
    expect((await explore(`${home}/`)).code).toBe(OK);
    const seen = await cli("observe");
    await cli("act", "CLICK", /\[\s*(\d+)\s*\][^\n]*Bounce/.exec(seen.out)?.[1] as string);
    const findings = readEvents(log).filter((event) => event.type === "finding");
    expect(findings.map((event) => event.signal)).toEqual(["out_of_scope"]);
    expect(findings[0].url).toBe(`${out.slice("http://".length)}/redir-link`);
    expect(reached).toEqual([]);
    await finish();
  });
});
