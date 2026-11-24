/**
 * Phase 0 of docs/design-shared-browser.md: N sessions on N headless shells ("separate", today) against one shell with
 * N contexts ("shared", the design). Research only; not shipped.
 *
 *   node research/shared.ts [--sizes 2,4,8,16] [--rounds 5] [--reps 2]
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { SNAPSHOT } from "../src/browser/snapshot.ts";
import { sleep } from "../src/core/format.ts";
import { shellProbe } from "../src/engines/headless-shell.ts";
import { cliOption, pssMb, startFixtureServer } from "./lib/bench.ts";

const FIXTURES = [
  "hotel.html?scenario=travel",
  "plans_many.html",
  "settings_long.html",
  "cookie_wall.html",
  "plans.html",
];

interface Shell {
  child: ChildProcess;
  port: number;
  browserPath: string;
}

async function launch(): Promise<Shell> {
  const binary = shellProbe.binary();
  if (!binary) throw new Error("chrome-headless-shell not found");
  const dir = mkdtempSync(join(tmpdir(), "shared-"));
  const child = spawn(
    binary,
    ["--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1120,780", "about:blank"],
    { detached: true, stdio: "ignore" },
  );
  const file = join(dir, "DevToolsActivePort");
  while (!existsSync(file) || !readFileSync(file, "utf8").trim()) await sleep(10);
  const [port, path] = readFileSync(file, "utf8").split("\n");
  return { child, port: Number(port), browserPath: path.trim() };
}

function stop(shell: Shell): void {
  try {
    process.kill(-(shell.child.pid as number), "SIGKILL");
  } catch {
    // gone
  }
}

/** A minimal browser-level CDP client: what Playwright does not expose, contexts that outlive a connection. */
async function rawClient(shell: Shell) {
  const ws = new WebSocket(`ws://127.0.0.1:${shell.port}${shell.browserPath}`);
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });
  let id = 0;
  const pending = new Map<number, (message: { result?: Record<string, string> }) => void>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message);
  };
  return {
    send: (method: string, params: Record<string, unknown> = {}) =>
      new Promise<{ result?: Record<string, string> }>((resolve) => {
        const mine = ++id;
        pending.set(mine, resolve);
        ws.send(JSON.stringify({ id: mine, method, params }));
      }),
    close: () => ws.close(),
  };
}

interface Session {
  page: Page;
  context: BrowserContext;
}

async function read(session: Session, url: string): Promise<void> {
  await session.page.goto(url, { waitUntil: "load" });
  const cdp = await session.context.newCDPSession(session.page);
  try {
    const response = await cdp.send("Runtime.evaluate", { expression: `(${SNAPSHOT})({})`, returnByValue: true });
    if (response.exceptionDetails) throw new Error("snapshot failed");
  } finally {
    await cdp.detach().catch(() => {});
  }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

interface Result {
  mode: string;
  n: number;
  readySec: number;
  memoryMb: number;
  roundSec: number;
  roundMaxSec: number;
  note: string;
}

type Opened = { sessions: Session[]; stopAll: () => void; groups: () => number[]; extra: string[] };

async function openSeparate(n: number): Promise<Opened> {
  const shells = await Promise.all(Array.from({ length: n }, () => launch()));
  const browsers: Browser[] = [];
  const sessions = await Promise.all(
    shells.map(async (shell) => {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${shell.port}`);
      browsers.push(browser);
      const context = browser.contexts()[0];
      return { context, page: await context.newPage() };
    }),
  );
  return {
    sessions,
    stopAll: () => {
      for (const browser of browsers) browser.close().catch(() => {});
      for (const shell of shells) stop(shell);
    },
    groups: () => shells.map((shell) => shell.child.pid as number),
    extra: [],
  };
}

async function openShared(n: number): Promise<Opened> {
  const shell = await launch();
  const raw = await rawClient(shell);
  const contexts: string[] = [];
  for (let i = 0; i < n; i++) {
    const created = await raw.send("Target.createBrowserContext", { disposeOnDetach: false });
    const contextId = created.result?.browserContextId as string;
    contexts.push(contextId);
    await raw.send("Target.createTarget", { url: "about:blank", browserContextId: contextId });
  }
  raw.close();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${shell.port}`);
  const context = browser.contexts()[0];
  const byContext = new Map<string, Page>();
  for (let attempt = 0; attempt < 100 && byContext.size < n; attempt++) {
    for (const page of context.pages()) {
      const cdp = await context.newCDPSession(page);
      const info = (await cdp.send("Target.getTargetInfo")).targetInfo;
      await cdp.detach().catch(() => {});
      if (contexts.includes(info.browserContextId as string)) byContext.set(info.browserContextId as string, page);
    }
    if (byContext.size < n) await sleep(20);
  }
  const sessions = contexts.map((id) => ({ context, page: byContext.get(id) as Page }));
  const extra = byContext.size === n ? [] : [`only ${byContext.size}/${n} pages found`];
  return {
    sessions,
    stopAll: () => {
      browser.close().catch(() => {});
      stop(shell);
    },
    groups: () => [shell.child.pid as number],
    extra,
  };
}

async function measure(mode: "separate" | "shared", n: number, rounds: number, base: string): Promise<Result> {
  const t0 = Date.now();
  const opened = mode === "separate" ? await openSeparate(n) : await openShared(n);
  const notes = [...opened.extra];
  try {
    await Promise.all(opened.sessions.map((session) => session.page.goto("about:blank")));
    const readySec = (Date.now() - t0) / 1000;
    const times: number[] = [];
    let memoryMb = 0;
    for (let round = 0; round < rounds; round++) {
      const started = Date.now();
      const results = await Promise.allSettled(
        opened.sessions.map((session, i) => read(session, `${base}/${FIXTURES[(i + round) % FIXTURES.length]}`)),
      );
      times.push((Date.now() - started) / 1000);
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed) notes.push(`round ${round}: ${failed}/${n} failed`);
      if (round === 0) {
        await sleep(1500);
        memoryMb = opened.groups().reduce((sum, group) => sum + pssMb(group).mb, 0);
      }
    }
    return {
      mode,
      n,
      readySec: Number(readySec.toFixed(2)),
      memoryMb: Math.round(memoryMb),
      roundSec: Number(median(times).toFixed(2)),
      roundMaxSec: Number(Math.max(...times).toFixed(2)),
      note: notes.join("; "),
    };
  } finally {
    opened.stopAll();
    await sleep(800);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sizes = cliOption(args, "--sizes", "2,4,8,16").split(",").map(Number);
  const rounds = Number(cliOption(args, "--rounds", "5"));
  const reps = Number(cliOption(args, "--reps", "2"));

  const { server, base } = await startFixtureServer();
  const results: Result[] = [];
  for (const n of sizes) {
    for (let rep = 0; rep < reps; rep++) {
      for (const mode of ["separate", "shared"] as const) {
        console.error(`N=${n} rep ${rep + 1} ${mode}`);
        results.push(await measure(mode, n, rounds, base));
      }
    }
  }
  console.table(results);
  console.log(JSON.stringify({ sizes, rounds, reps, fixtures: FIXTURES, results }, null, 1));
  server.close();
  process.exit(0);
}

await main();
