import { afterEach, beforeEach, expect, test } from "vitest";
import { cli, cliExit, readEvents, research, researchExit } from "../helpers.ts";
import { isolate } from "../jev.ts";

let log: string;
let cleanup: () => Promise<void>;

beforeEach(() => {
  ({ log, cleanup } = isolate());
});

afterEach(async () => {
  await cleanup();
});

test("extract reads the page, prints the page's own text, and logs counts but no values", async () => {
  await research("start", "--task", "plan_lowest", "--chrome", "linux");
  const links = await cli("extract", "table");
  expect(links.code).toBe(0);
  expect(links.out).toContain("31 | Flax | 20 GB | €12 | Choose Flax   (page, table 1, row 31)");
  expect(links.out).toContain("RESULT: COMPLETE");
  const mismatch = await cli("extract", "table", "--expect-count", "999", "--columns", "Plan,Monthly price");
  expect(mismatch.code).toBe(6);
  expect(mismatch.out).toContain("COUNT_MISMATCH  expected 999 observed");
  const none = await cli("extract", "link");
  expect(none.code).toBe(7);
  expect(none.out).toContain("RESULT: INCONCLUSIVE  none");
  const json = JSON.parse((await cli("extract", "table", "--format", "json")).out);
  expect(json.kind).toBe("table");
  expect(json.records[30]).toMatchObject({ Plan: "Flax" });
  const event = readEvents(log).find((e) => e.type === "extract");
  expect(event).toMatchObject({ kind: "table", result: "COMPLETE" });
  expect(JSON.stringify(event)).not.toContain("Flax");
  await research("finish", "--status", "abandoned");
});

test("extract needs a session and a known kind", async () => {
  expect(await cliExit("extract", "link")).toContain("No active session");
});

test("--read-only says what it refuses, and does not mix with a person's steps, files or a stray --allow-control", async () => {
  const started = await research("start", "--task", "plan_lowest", "--chrome", "linux", "--read-only");
  expect(started.out).toMatch(/READ-ONLY: actions that submit a non-GET form, attach a file, or press a button/);
  await research("finish", "--status", "abandoned");
  expect(
    await researchExit("start", "--task", "plan_lowest", "--chrome", "linux", "--allow-control", "More"),
  ).toContain("--allow-control needs --read-only");
  expect(
    await researchExit(
      "start",
      "--task",
      "plan_lowest",
      "--chrome",
      "linux",
      "--read-only",
      "--step",
      "[person] Sign in",
      "--headed",
    ),
  ).toContain("no [person] steps");
});
