/** Verifies every starter template in examples/runbooks/ parses cleanly and follows safety rules. */

import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import * as batch from "../src/storage/batch.ts";
import * as runbook from "../src/storage/runbook/index.ts";
import { ROOT } from "./helpers.ts";

test("starter runbooks and sample CSV under examples/runbooks/ are valid, draft-only, and domain-scoped", () => {
  const examplesDir = join(ROOT, "examples", "runbooks");
  // Copy into the isolated test user runbooks folder so loadService / load work directly.
  const userRunbooks = runbook.root("user");
  mkdirSync(userRunbooks, { recursive: true });
  cpSync(join(examplesDir, "hotel-planisphere"), join(userRunbooks, "hotel-planisphere"), { recursive: true });
  cpSync(join(examplesDir, "internal-form"), join(userRunbooks, "internal-form"), { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(process.env.WEBHAND_HOME as string);

  const hotelSvc = runbook.loadService("hotel-planisphere");
  expect(hotelSvc?.allowed_domains).toEqual(["hotel-example-site.takeyaqa.dev"]);

  const internalSvc = runbook.loadService("internal-form");
  expect(internalSvc?.allowed_domains).toEqual(["portal.example.internal", "sso.example.internal"]);
  expect(internalSvc?.login.required).toBe(true);

  // Sample CSV validates every row against hotel-planisphere/reserve.toml
  const csvPath = join(examplesDir, "hotel-planisphere", "guests.sample.csv");
  const parsed = batch.parseCsv(readFileSync(csvPath, "utf8"));
  expect(parsed.rows.length).toBeGreaterThanOrEqual(2);
  for (const row of parsed.rows) {
    const book = runbook.load("hotel-planisphere/reserve", row);
    expect(book.status).toBe("draft");
  }

  const internalBook = runbook.load("internal-form/submit", {
    category: "Access",
    title: "Test request",
    summary: "Sample details",
  });
  expect(internalBook.status).toBe("draft");
  expect(internalBook.steps[0].actor).toBe("human");
});
