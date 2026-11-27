/** Tests for batch execution: CSV/JSON parsing, safety guards, privacy, and multi-row runs on real Chrome. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FAILED, OK } from "../src/commands/context.ts";
import * as batch from "../src/storage/batch.ts";
import * as runbook from "../src/storage/runbook/index.ts";
import * as session from "../src/storage/session.ts";
import { cli, cliExit, ROOT, tmpPath } from "./helpers.ts";
import { isolate, ScriptedJev } from "./jev.ts";

let cleanup: () => Promise<void>;

beforeEach(() => {
  ({ cleanup } = isolate());
  const emptyCwd = join(process.env.WEBHAND_HOME as string, "cwd");
  mkdirSync(emptyCwd, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(emptyCwd);
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
});

afterEach(async () => {
  await cleanup();
});

function installHotelRunbook(status: "approved" | "draft" = "approved", name = "stay/search"): string {
  const [service, proc] = name.split("/");
  const dir = join(runbook.root("user"), service, "runbooks");
  mkdirSync(dir, { recursive: true });
  const fixtureUrl = pathToFileURL(join(ROOT, "tasks", "fixtures", "hotel.html")).href;
  writeFileSync(
    join(dir, `${proc}.toml`),
    [
      `service = "${service}"`,
      `name = "${proc}"`,
      `status = "${status}"`,
      'goal = "Search for {Destination} and open {Hotel}"',
      `start_url = "${fixtureUrl}"`,
      "",
      "[params.Destination]",
      'description = "City to search"',
      "[params.Hotel]",
      'description = "Hotel to open"',
      "",
      "[[steps]]",
      'instruction = "Search for {Destination}"',
      "[[steps]]",
      'instruction = "Open {Hotel}"',
      "",
    ].join("\n"),
  );
  return name;
}

test("parseCsv handles quotes, commas, escaped quotes, CRLF, BOM, and rejects bad CSV", () => {
  const csv = '\uFEFFDestination,Hotel\r\n"Lisbon, PT","Casa ""Flora"""\r\nPorto,River View\r\n\r\n';
  const parsed = batch.parseCsv(csv);
  expect(parsed.keys).toEqual(["Destination", "Hotel"]);
  expect(parsed.rows).toEqual([
    { Destination: "Lisbon, PT", Hotel: 'Casa "Flora"' },
    { Destination: "Porto", Hotel: "River View" },
  ]);

  expect(() => batch.parseCsv("Destination,Hotel\n")).toThrow("at least one data row");
  expect(() => batch.parseCsv('Destination,Hotel\n"unclosed,x')).toThrow("unclosed quoted field");
  expect(() => batch.parseCsv("Destination,Destination\na,b\n")).toThrow("duplicate column");
  expect(() => batch.parseCsv("Destination,Hotel\nLisbon\n")).toThrow("expected 2 columns, got 1");
});

test("parseJsonRows handles flat objects with scalars and rejects invalid shapes", () => {
  const parsed = batch.parseJsonRows(JSON.stringify([{ Destination: "Lisbon", Nights: 2, Free: true }]));
  expect(parsed.rows).toEqual([{ Destination: "Lisbon", Nights: "2", Free: "true" }]);

  expect(() => batch.parseJsonRows("not json")).toThrow("Invalid JSON");
  expect(() => batch.parseJsonRows("[]")).toThrow("non-empty array");
  expect(() => batch.parseJsonRows("[1]")).toThrow("expected an object");
  expect(() => batch.parseJsonRows('[{"Destination": null}]')).toThrow("null or missing");
  expect(() => batch.parseJsonRows('[{"Destination": {"nested": 1}}]')).toThrow("string, number, or boolean");
});

test("batch init rejects credential columns, draft runbooks, and missing params upfront without storing values", async () => {
  installHotelRunbook("draft", "stay/draft_search");
  installHotelRunbook("approved", "stay/search");
  const dir = tmpPath();

  const secretCsv = join(dir, "secret.csv");
  writeFileSync(secretCsv, "Destination,Hotel,user_password\nLisbon,Casa Flora,s3cr3t\n");
  expect(await cliExit("batch", "init", "--runbook", "stay/search", "--input", secretCsv)).toContain(
    "credential columns",
  );

  const validCsv = join(dir, "stays.csv");
  writeFileSync(validCsv, "Destination,Hotel\nLisbon,Casa Flora\nLisbon,Sol Studio\n");
  expect(await cliExit("batch", "init", "--runbook", "stay/draft_search", "--input", validCsv)).toContain("is a draft");

  const badJson = join(dir, "missing.json");
  writeFileSync(badJson, JSON.stringify([{ Destination: "Lisbon" }]));
  expect(await cliExit("batch", "init", "--runbook", "stay/search", "--input", badJson)).toContain("Row 1:");

  const ok = await cli("batch", "init", "trip", "--runbook", "stay/search", "--input", validCsv);
  expect(ok.code).toBe(OK);
  expect(ok.out).toContain("BATCH CREATED trip");
  expect(ok.out).toContain("2 rows");

  // Batch state must NEVER persist raw row values from the CSV.
  const rawState = readFileSync(join(session.home(), "batches", "trip.json"), "utf8");
  expect(rawState).not.toContain("Casa Flora");
  expect(rawState).not.toContain("Sol Studio");
  expect(rawState).toContain("Destination");
});

test("batch runs multiple rows end-to-end on real Chrome, blocks retries on done/uncertain, and detects file edits", async () => {
  installHotelRunbook("approved", "stay/search");
  const dir = tmpPath();
  const inputJson = join(dir, "rows.json");
  writeFileSync(
    inputJson,
    JSON.stringify([
      { Destination: "Lisbon", Hotel: "Casa Flora" },
      { Destination: "Lisbon", Hotel: "Casa Flora" },
    ]),
  );

  const init = await cli("batch", "init", "hotels", "--runbook", "stay/search", "--input", inputJson);
  expect(init.code).toBe(OK);

  // Row 1: start -> run -> finish done
  const s1 = await cli("start", "--batch", "hotels", "--chrome", "linux");
  expect(s1.code).toBe(OK);
  expect(s1.out).toContain("BATCH: hotels row 1/2");

  ScriptedJev.moves = [
    ["TYPE_TEXT", "Destination", "Destination"],
    ["CLICK", "Find stays", null],
    ["CLICK", "Casa Flora", null],
    ["DONE", null, null],
  ];
  const r1 = await cli("run");
  expect(r1.code).toBe(OK);
  expect(r1.out).toContain("GOAL_REPORTED");
  expect(ScriptedJev.plans.length).toBeGreaterThan(0);

  const f1 = await cli("finish", "--status", "done", "--reason", "Casa Flora opened");
  expect(f1.code).toBe(OK);
  expect(f1.out).toContain("batch=hotels row=1/2 next=2");

  // Refuses to re-run already done row 1
  expect(await cliExit("start", "--batch", "hotels", "--row", "1", "--chrome", "linux")).toContain("already done");

  // Row 2: simulate UNCERTAIN -> finish records uncertain -> refuses retry
  const s2 = await cli("start", "--batch", "hotels", "--chrome", "linux");
  expect(s2.code).toBe(OK);
  expect(s2.out).toContain("BATCH: hotels row 2/2");
  const activeState = session.load();
  expect(activeState).not.toBeNull();
  if (activeState) {
    activeState.outcome = "UNCERTAIN";
    session.save(activeState);
  }
  const f2 = await cli("finish", "--status", "error", "--reason", "action outcome unclear");
  expect(f2.code).toBe(OK);
  expect(f2.out).toContain("batch=hotels row=2/2 batch_done=true");

  expect(await cliExit("start", "--batch", "hotels", "--row", "2", "--chrome", "linux")).toContain("ended UNCERTAIN");
  expect(await cliExit("start", "--batch", "hotels", "--chrome", "linux")).toContain("no pending rows left");

  // Status table + JSON
  const st = await cli("batch", "status", "hotels");
  expect(st.code).toBe(OK);
  expect(st.out).toContain("done=1 uncertain=1");
  expect(st.out).toContain("| 1 | done |");
  expect(st.out).toContain("| 2 | uncertain |");

  const stJson = await cli("batch", "status", "hotels", "--json");
  expect(stJson.code).toBe(OK);
  const parsed = JSON.parse(stJson.out) as { counts: Record<string, number> };
  expect(parsed.counts.done).toBe(1);
  expect(parsed.counts.uncertain).toBe(1);

  // Detecting input file mutation on a fresh batch
  const init2 = await cli("batch", "init", "drift", "--runbook", "stay/search", "--input", inputJson);
  expect(init2.code).toBe(OK);
  writeFileSync(inputJson, JSON.stringify([{ Destination: "Porto", Hotel: "Other" }]));
  expect(await cliExit("start", "--batch", "drift", "--chrome", "linux")).toContain("input file changed since init");
});

test("batch list, skip, clear, and option validation work cleanly", async () => {
  installHotelRunbook("approved", "stay/search");
  const dir = tmpPath();
  const csv = join(dir, "skip.csv");
  writeFileSync(csv, "Destination,Hotel\nLisbon,Casa Flora\nPorto,River View\n");

  const emptyList = await cli("batch", "list");
  expect(emptyList.code).toBe(OK);
  expect(emptyList.out).toContain("BATCHES: (none)");

  expect(await cliExit("start", "--row", "1")).toContain("--row needs --batch");

  await cli("batch", "init", "jobs", "--runbook", "stay/search", "--input", csv);
  const listed = await cli("batch", "list");
  expect(listed.out).toContain("jobs");
  expect(listed.out).toContain("pending=2");

  const skipped = await cli("batch", "skip", "jobs", "--row", "1", "--reason", "duplicate");
  expect(skipped.code).toBe(OK);
  expect(skipped.out).toContain("SKIPPED batch=jobs row=1 reason=duplicate");

  // Default `batch status` without name picks the latest batch
  const latest = await cli("batch", "status");
  expect(latest.code).toBe(OK);
  expect(latest.out).toContain("BATCH jobs");
  expect(latest.out).toContain("skipped=1");

  const cleared = await cli("batch", "clear", "jobs");
  expect(cleared.code).toBe(OK);
  expect(cleared.out).toContain("CLEARED batch jobs");

  const missingClear = await cli("batch", "clear", "jobs");
  expect(missingClear.code).toBe(FAILED);
});
