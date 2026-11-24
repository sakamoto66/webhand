/**
 * The page that has the target is not obvious: download the March 2026 invoice.
 *
 * Eight small pages share one top menu (Home, Orders, Tools, Reports, More). The invoices are under More, then
 * Billing; nothing on the other pages points there. For the stage 3 A/B: a run that knows the site (from an
 * earlier run that finished as done) against one that does not.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL =
  "On the Fieldnote site, download the March 2026 invoice. Stop when Downloaded March 2026 invoice is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "CLICK", label: "More" },
  { operation: "CLICK", label: "Billing" },
  { operation: "CLICK", label: "Download March 2026" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "menu_home.html")).href;
}

/** Reads which invoice the Billing page received. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const downloaded = (await browser.evaluate("document.body.dataset.downloaded ?? ''")) as string;
  return { success: downloaded === "March 2026", evidence: { downloaded } };
}
