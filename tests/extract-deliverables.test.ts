/** Tests for extract deliverables: --format markdown and safe --out PATH file export. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OK } from "../src/commands/context.ts";
import * as workspace from "../src/core/workspace.ts";
import { type Extraction, format } from "../src/extract/index.ts";
import { cli, cliExit, ROOT, tmpPath } from "./helpers.ts";
import { isolate } from "./jev.ts";

let cleanup: () => Promise<void>;

beforeEach(() => {
  ({ cleanup } = isolate());
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
});

afterEach(async () => {
  await cleanup();
});

test("formatMarkdown produces GFM table, escapes pipes, and lists missing columns and notes", () => {
  const extraction: Extraction = {
    kind: "table",
    url: "https://example.test/plans",
    at: "2026-11-24T12:00:00Z",
    count: 2,
    expected: null,
    columns: ["Plan", "Price"],
    missingColumns: ["Promo"],
    notes: ["1 hidden row left out"],
    result: "PARTIAL",
    records: [
      { source: "row 1", values: { Plan: "Basic | Starter", Price: "$10" } },
      { source: "row 2", values: { Plan: "Pro\nTeam", Price: "$30" } },
    ],
  };
  const md = format(extraction, "markdown");
  expect(md).toContain("# Extract: table");
  expect(md).toContain("- **Result**: PARTIAL");
  expect(md).toContain("- **Missing columns**: Promo");
  expect(md).toContain("| # | Plan | Price |");
  expect(md).toContain("| 1 | Basic \\| Starter | $10 |");
  expect(md).toContain("| 2 | Pro Team | $30 |");
  expect(md).toContain("## Notes");
  expect(md).toContain("- 1 hidden row left out");
});

test("extract --format markdown --out saves cleanly under cwd and rejects unsafe output paths", async () => {
  const workdir = tmpPath();
  vi.spyOn(process, "cwd").mockReturnValue(workdir);

  const fixtureUrl = pathToFileURL(join(ROOT, "tasks", "fixtures", "plans.html")).href;
  const started = await cli(
    "start",
    "--goal",
    "Read plans",
    "--url",
    fixtureUrl,
    "--step",
    "Wait",
    "--read-only",
    "--chrome",
    "linux",
  );
  expect(started.code).toBe(OK);

  // Rejects path traversal, .env files, and webhand state directory.
  expect(await cliExit("extract", "table", "--format", "csv", "--out", "../escape.csv")).toContain(
    "under the current directory",
  );
  expect(await cliExit("extract", "table", "--format", "csv", "--out", ".env.local")).toContain(".env");
  vi.spyOn(process, "cwd").mockReturnValue(join(workspace.home(), ".."));
  expect(
    await cliExit("extract", "table", "--format", "csv", "--out", join(workspace.stateHome(), "leak.csv")),
  ).toContain("saved state");

  // Writes cleanly inside cwd.
  vi.spyOn(process, "cwd").mockReturnValue(workdir);
  const outRel = join("reports", "plans.md");
  const ex = await cli("extract", "table", "--format", "markdown", "--out", outRel);
  expect(ex.code).toBe(OK);
  expect(ex.out).toContain("SAVED");
  expect(ex.out).toContain("format=markdown");

  const savedPath = join(workdir, outRel);
  expect(existsSync(savedPath)).toBe(true);
  const content = readFileSync(savedPath, "utf8");
  expect(content).toContain("# Extract: table");
  expect(content).toContain("| # |");

  await cli("finish", "--status", "done", "--reason", "extracted to file");
});
