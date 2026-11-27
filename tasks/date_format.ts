/**
 * Schedule a delivery on a page whose date field reads day/month/year and says so only in its placeholder.
 *
 * Numbers with slashes are read as DD/MM/YYYY; other shapes are rejected with Invalid date. The goal gives the date
 * the US way (March 4, 2026), so the entry 03/04/2026 is accepted and saved as 3 April; the confirmation does not
 * echo the date. Runs before the placeholder was added (the silent field) are not comparable. No network.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL =
  "On the Fieldnote Shop delivery page, schedule the delivery for March 4, 2026. Stop when Delivery scheduled is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "TYPE_TEXT", label: "Delivery date", text: "04/03/2026" },
  { operation: "CLICK", label: "Schedule delivery" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "date_format.html")).href;
}

/** Reads the date the page saved. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const date = (await browser.evaluate("document.body.dataset.date ?? ''")) as string;
  return { success: date === "2026-03-04", evidence: { date } };
}
