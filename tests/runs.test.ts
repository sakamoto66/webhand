import { existsSync, mkdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { OK } from "../src/commands/context.ts";
import { defaultLog } from "../src/commands/shared.ts";
import { Recorder } from "../src/core/metrics.ts";
import { autoPrune, keepDays, oldRuns, runsDir } from "../src/storage/runs.ts";
import { cli, cliExit } from "./helpers.ts";

const NOW = new Date(2026, 10, 27).getTime();

/** A run folder with one log, last changed at `changed`. */
function run(name: string, changed = new Date(2026, 8, 1)): string {
  const folder = join(runsDir(), name);
  mkdirSync(folder, { recursive: true });
  const log = join(folder, "task.jsonl");
  writeFileSync(log, "{}\n");
  utimesSync(log, changed, changed);
  utimesSync(folder, changed, changed);
  return folder;
}

test("only folders named by an old date, with nothing newer in them, are old", () => {
  const old = run("20260901T000000-abc123");
  const nested = run("webarena/20260902T000000");
  const named = run("experiment-1");
  const fresh = run("20261126T000000");
  const written = run("20260903T000000", new Date(2026, 10, 26));
  const open = run("20260904T000000");
  symlinkSync(named, join(runsDir(), "20260905T000000"));

  expect(oldRuns(30, [join(open, "task.jsonl")], NOW)).toEqual([old, nested]);
  expect([named, fresh, written].every(existsSync)).toBe(true);
});

test("old runs are removed at most once a day, and 0 days keeps them", () => {
  const first = run("20260901T000000");
  vi.stubEnv("WEBHAND_RUNS_KEEP_DAYS", "0");
  expect(autoPrune([], NOW)).toBeNull();
  expect(existsSync(first)).toBe(true);

  vi.stubEnv("WEBHAND_RUNS_KEEP_DAYS", "a month");
  expect(autoPrune([], NOW)).toContain("not a whole number");
  expect(existsSync(first)).toBe(true);

  vi.stubEnv("WEBHAND_RUNS_KEEP_DAYS", "");
  expect(keepDays()).toBe(30);
  expect(autoPrune([], NOW)).toContain("removed 1 run folder older than 30 days");
  expect(existsSync(first)).toBe(false);

  const second = run("20260902T000000");
  expect(autoPrune([], NOW + 3_600_000)).toBeNull();
  expect(existsSync(second)).toBe(true);
  expect(autoPrune([], NOW + 90_000_000)).toContain("removed 1");
});

test("runs prune lists first and removes only with --yes", async () => {
  const old = run("20200101T000000", new Date(2020, 0, 1));
  const listed = await cli("runs", "prune");
  expect(listed.code).toBe(OK);
  expect(listed.out).toContain(old);
  expect(listed.out).toContain("Nothing was removed");
  expect(existsSync(old)).toBe(true);

  expect((await cli("runs", "prune", "--yes")).out).toContain("REMOVED 1");
  expect(existsSync(old)).toBe(false);
  expect(await cliExit("runs", "list", "--older-than", "0")).toContain("--older-than");
});

test("run logs are the person's alone and two of one name do not share a file", () => {
  const first = defaultLog("task");
  const second = defaultLog("task");
  expect(first).not.toBe(second);
  const recorder = new Recorder(first);
  recorder.close();
  expect(statSync(first).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(first)).mode & 0o777).toBe(0o700);
  expect(statSync(runsDir()).mode & 0o777).toBe(0o700);
});
