/**
 * Read a list split over pages, then act on what was read: choose the cheapest of 40 plans.
 *
 * Ten plans a page over four pages; Next page and Previous page links below the table open the others, each
 * at its own address. The cheapest plan is on the third page, and a featured plan's button comes first on
 * every page. The plans of other pages are not in the page, so no observation can show them. No network, no
 * accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "In the All plans table, choose the plan with the lowest monthly price by pressing its Choose button. " +
  "The plans are split over several pages; use Next page below the table to see the others. Do not choose the featured plan unless it is the " +
  "cheapest. Stop when Plan chosen is shown.";

// The scripted policy's reference run only scrolls; it does not know the answer. verify() works out the
// expected plan from the page's full list, so reading this file does not give the answer away.
export const SCRIPT: ScriptStep[] = [{ operation: "SCROLL_DOWN" }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "plan_pages.html")).href;
}

// The cheapest plan in the page's full list, loaded or not.
const LOWEST = "PLANS.reduce((best, plan) => (best === null || plan[2] < best[2] ? plan : best), null)?.[0] ?? null";

/** Reads which plan the page recorded. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const chosen = await browser.evaluate("document.body.dataset.chosen ?? null");
  const expected = await browser.evaluate(LOWEST);
  return { success: expected !== null && chosen === expected, evidence: { chosen, expected } };
}
