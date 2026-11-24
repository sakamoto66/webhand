/**
 * E1: compare browser engines without a model. Start time, memory (PSS summed over the process group), how steadily
 * snapshot reads the same page across fresh launches, how closely each engine's action list matches Chrome's, and
 * what 8 sessions at once cost. Research only; not shipped.
 *
 *   node research/engines.ts [--reps N] [--sessions N] [--engines a,b,c]
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { SNAPSHOT } from "../src/browser/snapshot.ts";
import { sleep } from "../src/core/format.ts";
import { shellProbe } from "../src/engines/headless-shell.ts";
import { cliOption, pssMb, startFixtureServer } from "./lib/bench.ts";

const FIXTURES = [
  "hotel.html?scenario=travel",
  "plans.html",
  "settings_long.html",
  "cookie_wall.html",
  "signup_ticker.html",
  "plan_pages.html",
];
const STOCK = SNAPSHOT;
const PATCHED = STOCK.replace("[...select.selectedOptions]", "[...select.options].filter(option => option.selected)");

interface Engine {
  name: string;
  start(port: number, dir: string): [string, string[]];
  snapshot: string;
  ownPort: boolean;
  multiPage: boolean;
}

const CHROME_FLAGS = (dir: string, height: number) => [
  "--remote-debugging-port=0",
  `--user-data-dir=${dir}`,
  "--no-first-run",
  "--no-sandbox",
  `--window-size=1120,${height}`,
  "about:blank",
];
const OBSCURA = process.env.OBSCURA ?? join(homedir(), ".local", "share", "obscura", "obscura");

function engines(): Engine[] {
  const shell = shellProbe.binary();
  const all: (Engine | null)[] = [
    {
      name: "chrome-new-headless",
      start: (_p, dir) => ["/usr/bin/google-chrome", ["--headless=new", ...CHROME_FLAGS(dir, 867)]],
      snapshot: STOCK,
      ownPort: true,
      multiPage: true,
    },
    shell
      ? {
          name: "chrome-headless-shell",
          start: (_p, dir) => [shell, CHROME_FLAGS(dir, 780)],
          snapshot: STOCK,
          ownPort: true,
          multiPage: true,
        }
      : null,
    {
      name: "lightpanda",
      start: (port) => ["lightpanda", ["serve", "--host", "127.0.0.1", "--port", String(port)]],
      snapshot: STOCK,
      ownPort: false,
      multiPage: false,
    },
    existsSync(OBSCURA)
      ? {
          name: "obscura",
          start: (port) => [OBSCURA, ["serve", "--port", String(port), "--allow-private-network"]],
          snapshot: STOCK,
          ownPort: false,
          multiPage: true,
        }
      : null,
    existsSync(OBSCURA)
      ? {
          name: "obscura+patched",
          start: (port) => [OBSCURA, ["serve", "--port", String(port), "--allow-private-network"]],
          snapshot: PATCHED,
          ownPort: false,
          multiPage: true,
        }
      : null,
  ];
  return all.filter((engine): engine is Engine => engine !== null);
}

let nextPort = 9500;

interface Running {
  child: ChildProcess;
  browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
  startMs: number;
}

async function launch(engine: Engine): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), "engines-"));
  let port = nextPort++;
  const [command, args] = engine.start(port, dir);
  const t0 = Date.now();
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  if (engine.ownPort) {
    const file = join(dir, "DevToolsActivePort");
    while (!existsSync(file) || !readFileSync(file, "utf8").trim()) await sleep(20);
    port = Number(readFileSync(file, "utf8").split("\n")[0]);
  }
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {
      // not listening yet
    }
    await sleep(20);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return { child, browser, startMs: Date.now() - t0 };
}

async function stop(run: Running): Promise<void> {
  await run.browser.close().catch(() => {});
  try {
    process.kill(-(run.child.pid as number), "SIGKILL");
  } catch {
    // gone
  }
}

async function read(engine: Engine, base: string, run: Running, fixture: string) {
  const context = run.browser.contexts()[0] ?? (await run.browser.newContext());
  const page =
    context.pages().find((p) => p.url() !== "about:blank" && p.url().startsWith(base)) ?? (await context.newPage());
  await page.goto(`${base}/${fixture}`, { waitUntil: "load" });
  await sleep(150);
  const cdp = await context.newCDPSession(page);
  const response = await cdp.send("Runtime.evaluate", {
    expression: `(${engine.snapshot})({})`,
    returnByValue: true,
  });
  await cdp.detach().catch(() => {});
  if (response.exceptionDetails) {
    throw new Error(String(response.exceptionDetails.exception?.description ?? "snapshot failed").split("\n")[0]);
  }
  return response.result.value as {
    url: string;
    title: string;
    text: string;
    scroll: unknown;
    actions: { label: string; kind: string; role: string; region: string }[];
  };
}

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 10);

async function measureMemory(engine: Engine, base: string, notes: string[]) {
  const first = await launch(engine);
  const startMs = first.startMs;
  await sleep(1200);
  const idleMb = Math.round(pssMb(first.child.pid as number).mb);
  let onePageMb = 0;
  let fourPagesMb: number | string = "n/a";
  try {
    const context = first.browser.contexts()[0] ?? (await first.browser.newContext());
    const page = await context.newPage();
    await page.goto(`${base}/${FIXTURES[0]}`, { waitUntil: "load" });
    await sleep(1200);
    onePageMb = Math.round(pssMb(first.child.pid as number).mb);
    if (engine.multiPage) {
      for (let i = 0; i < 3; i++) {
        const more = await context.newPage();
        await more.goto(`${base}/${FIXTURES[0]}`, { waitUntil: "load" });
      }
      await sleep(1200);
      fourPagesMb = Math.round(pssMb(first.child.pid as number).mb);
    }
  } catch (error) {
    notes.push(`pages: ${(error as Error).message.split("\n")[0]}`);
  }
  await stop(first);

  const four4: Running[] = [];
  for (let i = 0; i < 4; i++) {
    const run = await launch(engine);
    try {
      const context = run.browser.contexts()[0] ?? (await run.browser.newContext());
      const page = await context.newPage();
      await page.goto(`${base}/${FIXTURES[0]}`, { waitUntil: "load" });
    } catch {
      // counted as launched anyway
    }
    four4.push(run);
  }
  await sleep(1200);
  const fourBrowsersMb = four4.reduce((sum, run) => sum + Math.round(pssMb(run.child.pid as number).mb), 0);
  for (const run of four4) await stop(run);
  return { startMs, idleMb, onePageMb, fourPagesMb, fourBrowsersMb };
}

async function measureStability(engine: Engine, base: string, reps: number, notes: string[]) {
  const hashes = new Map<string, Set<string>>();
  const shapes = new Map<string, Map<string, number>>();
  let failures = 0;
  let firstError = "";
  for (let rep = 0; rep < reps; rep++) {
    const run = await launch(engine);
    for (const fixture of FIXTURES) {
      try {
        const state = await read(engine, base, run, fixture);
        const full = sha({
          url: state.url.replace(base, ""),
          title: state.title,
          text: state.text,
          scroll: state.scroll,
          actions: state.actions,
        });
        const shape = sha(state.actions.map((a) => [a.label, a.kind, a.role, a.region]));
        if (!hashes.has(fixture)) hashes.set(fixture, new Set());
        hashes.get(fixture)?.add(full);
        const counts = shapes.get(fixture) ?? new Map<string, number>();
        counts.set(shape, (counts.get(shape) ?? 0) + 1);
        shapes.set(fixture, counts);
      } catch (error) {
        failures++;
        if (!firstError) firstError = (error as Error).message.slice(0, 90);
      }
    }
    await stop(run);
  }
  const total = reps * FIXTURES.length;
  const stableFixtures = FIXTURES.filter((f) => hashes.get(f)?.size === 1 && shapes.get(f)?.size === 1).length;
  const modal = new Map<string, string>();
  for (const [fixture, counts] of shapes) {
    modal.set(fixture, [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }
  if (firstError) notes.push(`read: ${firstError}`);
  return { readable: `${total - failures}/${total}`, stable: `${stableFixtures}/${FIXTURES.length}`, modal };
}

async function measureConcurrency(engine: Engine, base: string, sessions: number, notes: string[]) {
  let concurrentSec: number | string = "n/a";
  let concurrentMb: number | string = "n/a";
  try {
    const t0 = Date.now();
    const runs = await Promise.all(Array.from({ length: sessions }, () => launch(engine)));
    const reads = await Promise.allSettled(runs.map((run) => read(engine, base, run, FIXTURES[1])));
    concurrentSec = Number(((Date.now() - t0) / 1000).toFixed(1));
    await sleep(800);
    concurrentMb = runs.reduce((sum, run) => sum + Math.round(pssMb(run.child.pid as number).mb), 0);
    const bad = reads.filter((r) => r.status === "rejected").length;
    if (bad) notes.push(`concurrent: ${bad}/${sessions} reads failed`);
    for (const run of runs) await stop(run);
  } catch (error) {
    notes.push(`concurrent: ${(error as Error).message.split("\n")[0]}`);
  }
  return { concurrentSec, concurrentMb };
}

interface Result {
  engine: string;
  startMs: number;
  idleMb: number;
  onePageMb: number;
  fourPagesMb: number | string;
  fourBrowsersMb: number;
  readable: string;
  stable: string;
  sameAsChrome: string;
  concurrentSec: number | string;
  concurrentMb: number | string;
  note: string;
}

async function main() {
  const args = process.argv.slice(2);
  const reps = Number(cliOption(args, "--reps", "10"));
  const sessions = Number(cliOption(args, "--sessions", "8"));
  const wanted = cliOption(args, "--engines", "").split(",").filter(Boolean);

  const { server, base } = await startFixtureServer();
  const structures = new Map<string, Map<string, string>>();
  const results: Result[] = [];
  for (const engine of engines().filter((e) => wanted.length === 0 || wanted.includes(e.name))) {
    console.error(`== ${engine.name}`);
    const notes: string[] = [];
    const memory = await measureMemory(engine, base, notes);
    const stability = await measureStability(engine, base, reps, notes);
    structures.set(engine.name, stability.modal);
    const concurrency = await measureConcurrency(engine, base, sessions, notes);
    results.push({
      engine: engine.name,
      ...memory,
      readable: stability.readable,
      stable: stability.stable,
      sameAsChrome: "",
      ...concurrency,
      note: notes.join("; "),
    });
  }

  const baseline = structures.get("chrome-new-headless");
  for (const result of results) {
    const mine = structures.get(result.engine);
    if (!baseline || !mine) continue;
    result.sameAsChrome = `${FIXTURES.filter((f) => mine.get(f) && mine.get(f) === baseline.get(f)).length}/${FIXTURES.length}`;
  }
  console.table(results);
  console.log(JSON.stringify({ reps, sessions, fixtures: FIXTURES, results }, null, 1));
  server.close();
  process.exit(0);
}

await main();
