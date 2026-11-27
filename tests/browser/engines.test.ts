/** Real engines (Lightpanda, Obscura) on the local fixtures, started by session.startChrome. Each is skipped where it is not installed. */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadTask } from "../../research/tasks.ts";
import { Budget, runAgent } from "../../src/agent/index.ts";
import { Browser } from "../../src/browser/index.ts";
import { Recorder } from "../../src/core/metrics.ts";
import { type Action, StalePage } from "../../src/core/types.ts";
import { type Driver, RemoteBrowser } from "../../src/ipc/remote.ts";
import { ScriptedPolicy } from "../../src/policies/scripted.ts";
import * as session from "../../src/storage/session.ts";
import { cli, cliExit, ROOT, tmpPath } from "../helpers.ts";

// Obscura's release archive is unpacked by hand; its guard against loopback addresses is lifted for the local fixtures.
const OBSCURA = process.env.WEBHAND_OBSCURA ?? join(homedir(), ".local", "share", "obscura", "obscura");
if (existsSync(OBSCURA)) process.env.WEBHAND_OBSCURA = OBSCURA;
process.env.WEBHAND_OBSCURA_ALLOW_PRIVATE = "1";

function installed(engine: string): boolean {
  if (engine === "obscura") return existsSync(OBSCURA);
  try {
    execFileSync(engine, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let state: session.State | null = null;
let browser: Driver | null = null;
let server: Server | null = null;

/** Lightpanda cannot open file: URLs, so the fixtures are served over http from the repository root. */
async function serve(fileUrl: string): Promise<string> {
  const start = new URL(fileUrl);
  const root = fileURLToPath(new URL(`file://${ROOT}/`));
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  server = createServer((request, response) => {
    const path = join(root, decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname));
    readFile(path).then(
      (body) => response.writeHead(200, { "content-type": types[extname(path)] ?? "text/plain" }).end(body),
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}${start.pathname.slice(root.length - 1)}${start.search}`;
}

afterEach(async () => {
  server?.close();
  server = null;
  await browser?.close();
  if (state) await session.stopChrome(state);
  state = null;
  browser = null;
});

describe.each(["lightpanda", "obscura"])("%s", (engine) => {
  test.skipIf(!installed(engine))(
    "the page survives between connections, and a scripted run passes verify()",
    async () => {
      const task = await loadTask("hotel_filter");
      state = await session.startChrome({ engine });
      const socket = state.socket as string;
      const start = await serve(task.startUrl(ROOT));

      // One command opens the page and ends, as webhand commands do.
      const first = await RemoteBrowser.connect(socket);
      await first.goto(start);
      const before = await first.observe();
      await first.close();

      // The next command finds the same page, not about:blank.
      browser = await RemoteBrowser.connect(socket);
      const after = await browser.observe();
      expect(after.url).toBe(before.url);
      expect(after.title).toBe(before.title);

      const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
      const result = await runAgent(
        browser,
        new ScriptedPolicy(task.SCRIPT),
        { goal: task.GOAL, steps: [], values: [] },
        recorder,
        new Budget(),
      );
      recorder.close();
      expect(result.outcome).toBe("GOAL_REPORTED");
      expect((await task.verify(browser as unknown as Browser)).success).toBe(true);
    },
  );

  test.skipIf(!installed(engine))(
    "the CLI runs separate commands on --engine, and finish stops the daemon",
    async () => {
      vi.stubEnv("TYPESAFE_API_KEY", "test");
      const task = await loadTask("hotel_filter");
      const url = await serve(task.startUrl(ROOT));
      const started = await cli("start", "--engine", engine, "--goal", "Look at the page", "--url", url);
      expect(started.code).toBe(0);
      expect(started.out).toContain(`(${engine === "obscura" ? "Obscura" : "Lightpanda"})`);
      const saved = session.load();
      expect(saved?.engine).toBe(engine);
      expect(saved?.chrome).toBe("linux");
      // A later command is a new connection; the page is still there.
      const seen = await cli("observe");
      expect(seen.out).toContain("Find stays");
      const pid = saved?.pid as number;
      await cli("finish", "--status", "abandoned", "--reason", "test");
      expect(() => process.kill(pid, 0)).toThrow();
      vi.unstubAllEnvs();
    },
  );

  test("--chrome no longer takes an engine, and a window or profile is refused", async () => {
    await expect(cli("start", "--chrome", engine, "--goal", "g", "--url", "http://127.0.0.1/")).rejects.toThrow(
      /argument --chrome/,
    );
    vi.stubEnv("TYPESAFE_API_KEY", "test");
    expect(
      await cliExit("start", "--engine", engine, "--headed", "--goal", "g", "--url", "http://127.0.0.1/"),
    ).toContain("no window");
    expect(
      await cliExit("start", "--engine", engine, "--session", "profile:x", "--goal", "g", "--url", "http://127.0.0.1/"),
    ).toContain("no saved profile");
    vi.unstubAllEnvs();
  });

  test.skipIf(!installed(engine))("a refused action comes back as the same error class", async () => {
    state = await session.startChrome({ engine });
    const remote = await RemoteBrowser.connect(state.socket as string);
    browser = remote;
    await remote.goto(await serve(`file://${ROOT}/tasks/fixtures/hotel.html?scenario=travel`));
    const page = await remote.observe();
    const button = page.actions.find((a: { label?: string }) => a.label === "Find stays") as Action;
    await remote.evaluate("document.getElementById('destination').value='changed'");
    await expect(remote.act(button, page)).rejects.toBeInstanceOf(StalePage);
  });
});

for (const engine of ["lightpanda", "obscura"]) {
  test.skipIf(!installed(engine))(
    `a click that asks for a new window is noted, and the page stays (${engine})`,
    async () => {
      server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          request.url === "/b.html"
            ? "<title>B</title>bee"
            : // In paragraphs: Obscura gives an inline element straight under <body> no size, so it is not offered.
              '<title>A</title><p><a href="/b.html" target="_blank">Open in a new window</a></p>' +
                "<p><button onclick=\"window.open('/b.html')\">Pop up</button></p>",
        );
      });
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      state = await session.startChrome({ engine });
      const remote = await RemoteBrowser.connect(state.socket as string);
      browser = remote;
      await remote.goto(`${base}/`);
      let page = await remote.observe();
      expect(await remote.ignoredWindows()).toEqual([]);
      // Lightpanda ignores target=_blank. Obscura loads its target in the same tab, so only window.open is ignored.
      for (const label of engine === "obscura" ? ["Pop up"] : ["Open in a new window", "Pop up"]) {
        const control = page.actions.find((a: { label?: string }) => a.label === label) as Action;
        await remote.act(control, page);
        expect(await remote.ignoredWindows()).toEqual([`${base}/b.html`]);
        page = await remote.observe();
        expect(page.title).toBe("A");
      }
      if (engine === "obscura") {
        const link = page.actions.find((a: { label?: string }) => a.label === "Open in a new window") as Action;
        await remote.act(link, page);
        expect((await remote.observe()).title).toBe("B"); // the page changed: no new window, and nothing to note
      }
    },
  );
}

describe("headless-shell", () => {
  async function start(): Promise<session.State | null> {
    try {
      return await session.startChrome({ engine: "headless-shell" });
    } catch (error) {
      if (/was not found/.test(String(error))) return null;
      throw error;
    }
  }

  test("reads the same viewport as Chrome, keeps the page between connections, and passes verify()", async (context) => {
    const shell = await start();
    if (!shell) return context.skip();
    state = shell;
    const task = await loadTask("hotel_filter");
    const first = await Browser.open(await serve(task.startUrl(ROOT)), { port: state.port });
    const page = await first.observe();
    expect([page.w, page.h]).toEqual([1120, 780]); // Chrome's viewport: the shell's window is sized to match
    await first.close();
    const second = await Browser.open(null, { port: state.port });
    try {
      expect((await second.observe()).url).toBe(page.url);
      const recorder = new Recorder(join(tmpPath(), "run.jsonl"));
      const result = await runAgent(
        second,
        new ScriptedPolicy(task.SCRIPT),
        { goal: task.GOAL, steps: [], values: [] },
        recorder,
        new Budget(),
      );
      recorder.close();
      expect(result.outcome).toBe("GOAL_REPORTED");
      expect((await task.verify(second)).success).toBe(true);
    } finally {
      await second.close();
    }
  });

  test("with no --engine, a plain run uses it; --engine chrome and --headed keep Chrome", async (context) => {
    const probe = await start();
    if (!probe) return context.skip();
    await session.stopChrome(probe);
    vi.stubEnv("TYPESAFE_API_KEY", "test");
    vi.stubEnv("WEBHAND_ENGINE", "auto"); // The suite pins chrome; this is the default a person gets
    const task = await loadTask("hotel_filter");
    const url = await serve(task.startUrl(ROOT));
    const plain = await cli("start", "--goal", "Look", "--url", url);
    expect(plain.out).toContain("(Chrome headless shell)");
    await cli("finish", "--status", "abandoned", "--reason", "test");
    const forced = await cli("start", "--engine", "chrome", "--chrome", "linux", "--goal", "Look", "--url", url);
    expect(forced.out).toContain("(linux Chrome)");
    await cli("finish", "--status", "abandoned", "--reason", "test");
    vi.unstubAllEnvs();
  });

  test("the CLI starts it with --engine and reports it", async (context) => {
    const probe = await start();
    if (!probe) return context.skip();
    await session.stopChrome(probe);
    vi.stubEnv("TYPESAFE_API_KEY", "test");
    const task = await loadTask("hotel_filter");
    const started = await cli(
      "start",
      "--engine",
      "headless-shell",
      "--goal",
      "Look",
      "--url",
      await serve(task.startUrl(ROOT)),
    );
    expect(started.out).toContain("(Chrome headless shell)");
    expect(session.load()?.engine).toBe("headless-shell");
    expect((await cli("observe")).out).toContain("Find stays");
    await cli("finish", "--status", "abandoned", "--reason", "test");
    vi.unstubAllEnvs();
  });
});

// Obscura keeps no page after a connection ends, and a click cannot open a second tab in it (target=_blank loads in the
// same tab), so the tab switch is tried in one process, with a second page made through the connection.
test.skipIf(!installed("obscura"))("webhand switches tabs on Obscura even without Page.bringToFront", async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(request.url === "/b.html" ? "<title>Second</title><p>two</p>" : "<title>First</title><p>one</p>");
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const port = 9840 + Math.floor(Math.random() * 100);
  const engine = spawn(OBSCURA, ["serve", "--port", String(port), "--allow-private-network"], {
    detached: true,
    stdio: "ignore",
  });
  let opened: Browser | null = null;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    opened = await Browser.open(`${base}/`, { port, rememberTab: false, compat: true });
    await (await opened.context.newPage()).goto(`${base}/b.html`);
    let page = await opened.observe();
    expect(page.tabs).toEqual({ count: 2, current: 1 });
    const tab = page.actions.find((a: { kind?: string }) => a.kind === "tab") as Action;
    await opened.act(tab, page);
    page = await opened.observe();
    expect(page.title).toBe("Second");
  } finally {
    await opened?.close();
    try {
      process.kill(-(engine.pid as number), "SIGKILL");
    } catch {
      // gone
    }
  }
});

// What Obscura lacks that a page's own script or snapshot.js uses, added to the page by the compat option.
test.skipIf(!installed("obscura"))(
  "on Obscura a form's controls are reachable by name, and an editable div is a textbox",
  async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<title>Form</title><body>" +
          "<form id=\"f\" onsubmit=\"event.preventDefault();document.title='sent:'+this.guest.value+':'+document.forms.f.guest.value\">" +
          '<label>Guest <input name="guest"></label><button>Register</button></form>' +
          '<div contenteditable="true" aria-label="Notes">n</div></body>',
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    state = await session.startChrome({ engine: "obscura" });
    const remote = await RemoteBrowser.connect(state.socket as string);
    browser = remote;
    await remote.goto(`${base}/`);
    let page = await remote.observe();
    const notes = page.actions.find((a: { label?: string }) => a.label?.includes("Notes")) as {
      role?: string;
      kind?: string;
    };
    expect([notes?.role, notes?.kind]).toEqual(["textbox", "fill"]);
    await remote.act(page.actions.find((a: { label?: string }) => a.label === "Guest") as Action, page, "Ann");
    page = await remote.observe();
    await remote.act(page.actions.find((a: { label?: string }) => a.label === "Register") as Action, page);
    expect(await remote.evaluate("document.title")).toBe("sent:Ann:Ann");
  },
);
