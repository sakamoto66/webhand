/**
 * menu_invoice after the site changed: Billing moved from More to Tools.
 *
 * The same pages and file names in tasks/fixtures/menu_moved. A run that knows the site as it was (More, then
 * Billing) is offered a way that no longer leads to the invoices. For the stage 3 A/B of out-of-date knowledge.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Fieldnote site, download the March 2026 invoice. Stop when Downloaded March 2026 invoice is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "CLICK", label: "Tools" },
  { operation: "CLICK", label: "Billing" },
  { operation: "CLICK", label: "Download March 2026" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "menu_moved/menu_home.html")).href;
}

/** Reads which invoice the Billing page received. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const downloaded = (await browser.evaluate("document.body.dataset.downloaded ?? ''")) as string;
  return { success: downloaded === "March 2026", evidence: { downloaded } };
}
