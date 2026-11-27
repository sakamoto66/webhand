/** Saved checks: loading, validation, the CLI refusals that happen before a browser opens, and the previous-run lookup. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { lastRuns } from "../src/commands/checklast.ts";
import * as workspace from "../src/core/workspace.ts";
import * as checkfile from "../src/storage/checkfile.ts";
import * as runbook from "../src/storage/runbook/index.ts";
import { cli, cliExit } from "./helpers.ts";

const FILE = `
service = "linen"
name = "order"
status = "approved"
env = "test"
start_url = "{base_url}/shop"

[params.base_url]
description = "Origin"

[[checks]]
id = "C1"
title = "Total shown"
steps = ["Press the calculate button"]
stop = "Stop when the result is shown."
expect = ['text:合計: ¥{total}', 'count:button=3']
manual = ["The layout is readable"]

[[checks]]
id = "C2"
title = "Order accepted"
steps = ["Press the order button"]
expect = ['text:注文を受け付けました']
depends_on = ["C1"]
`;

function save(name: string, text: string): string {
  const [service, stem] = name.split("/");
  const file = join(workspace.home(), "services", service, "checks", `${stem}.toml`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text.replace('name = "order"', `name = "${stem}"`));
  return file;
}

test("a valid file loads with a digest and its checks", () => {
  save(
    "linen/order",
    FILE.replace("{base_url}/shop", "{base_url}/shop").replace(
      "[params.base_url]",
      '[params.total]\ndescription = "Total"\n\n[params.base_url]',
    ),
  );
  const file = checkfile.load("linen/order");
  expect(file.status).toBe("approved");
  expect(file.checks.map((c) => c.id)).toEqual(["C1", "C2"]);
  expect(file.digest).toMatch(/^[0-9a-f]{16}$/);
});

test("an undeclared parameter, a missing status and a bad expectation are refused", () => {
  save("linen/a", FILE);
  expect(() => checkfile.load("linen/a")).toThrow(/\{total\} is used but not declared/);
  save("linen/b", FILE.replace('status = "approved"', 'status = "ready"'));
  expect(() => checkfile.load("linen/b")).toThrow(/status must be draft or approved/);
  save("linen/c", FILE.replace("{total}", "1").replace("text:注文", "texts:注文"));
  expect(() => checkfile.load("linen/c")).toThrow(/Unknown expectation/);
  save("linen/d", FILE.replace("{total}", "1").replace('["C1"]', '["C9"]'));
  expect(() => checkfile.load("linen/d")).toThrow(/unknown "C9"/);
});

test("fill needs every value", () => {
  expect(checkfile.fill("a {x} b", { x: "1" })).toBe("a 1 b");
  expect(() => checkfile.fill("a {x}", {})).toThrow(/No value for \{x\}/);
});

test("a folder holding only saved checks is not listed as a service", () => {
  save("linen/order", FILE);
  expect(runbook.catalog().map((entry) => entry.service)).not.toContain("linen");
  expect(checkfile.catalog().map((entry) => entry.name)).toContain("linen/order");
});

test("the catalog lists a broken file with its reason", () => {
  save("linen/order", FILE);
  const listed = checkfile.catalog();
  expect(listed.find((item) => item.name === "linen/order")?.error).toMatch(/\{total\} is used but not declared/);
});

test("--saved refuses a draft and a production run of a non-read-only check, before any browser opens", async () => {
  const text = FILE.replace("{total}", "1")
    .replace('start_url = "{base_url}/shop"', 'start_url = "x"')
    .replace('[params.base_url]\ndescription = "Origin"', '[params.p]\ndescription = "p"');
  save("linen/draft", text.replace("approved", "draft").replace('name = "order"', 'name = "draft"'));
  save("linen/live", text.replace('name = "order"', 'name = "live"'));
  expect(await cliExit("check", "--saved", "linen/draft:C1")).toMatch(/is a draft/);
  expect(await cliExit("check", "--saved", "linen/live:C1", "--production")).toMatch(/not read-only/);
  expect(await cliExit("check", "--saved", "linen/live:Z9")).toMatch(/has no "Z9"/);
  expect(await cliExit("check", "--saved", "nope")).toMatch(/Expected --saved/);
  expect(await cliExit("check", "--saved", "a/b:C1", "--expect", "text:x")).toMatch(/not both/);
});

test("check-last reports the latest run per check and flags a changed check", async () => {
  const text = FILE.replace("{total}", "1")
    .replace('start_url = "{base_url}/shop"', 'start_url = "x"')
    .replace('[params.base_url]\ndescription = "Origin"', '[params.p]\ndescription = "p"');
  save("linen/order", text);
  const digest = checkfile.load("linen/order").digest;
  const run = join(workspace.home(), "runs", "20261121T100000");
  mkdirSync(run, { recursive: true });
  const event = (id: string, verdict: string, at: string, d = digest) =>
    JSON.stringify({ type: "check_run", check: "linen/order", id, digest: d, verdict, manual: 0, at });
  writeFileSync(
    join(run, "adhoc.jsonl"),
    [
      event("C1", "PASS", "2026-11-21T10:00:00Z"),
      event("C1", "FAIL", "2026-11-21T11:00:00Z"),
      event("C2", "PASS", "2026-11-21T10:00:00Z", "oldoldoldoldold0"),
    ].join("\n"),
  );
  expect(lastRuns("linen/order").get("C1")?.verdict).toBe("FAIL");
  const out = (await cli("check-last", "linen/order")).out;
  expect(out).toContain("C1 FAIL at 2026-11-21T11:00:00Z");
  expect(out).toContain("(same check)");
  expect(out).toContain("THE CHECK CHANGED");
});
