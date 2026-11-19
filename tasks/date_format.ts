/**
 * Schedule a delivery on a page whose date field reads day/month/year without saying so.
 *
 * Numbers with slashes are read as DD/MM/YYYY; other shapes are rejected with Invalid date. A US-style entry
 * (04/03/2026) is accepted and saved as 4 March; the confirmation does not echo the date. For the learning A/B:
 * a fact of the service (the field reads day first) against none. No network.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Fieldnote Shop delivery page, schedule the delivery for 3 April 2026. Stop when Delivery scheduled is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "TYPE_TEXT", label: "Delivery date", text: "03/04/2026" },
  { operation: "CLICK", label: "Schedule delivery" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "date_format.html")).href;
}

/** Reads the date the page saved. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const date = (await browser.evaluate("document.body.dataset.date ?? ''")) as string;
  return { success: date === "2026-04-03", evidence: { date } };
}
