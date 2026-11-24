/**
 * Read a list that grows as it is scrolled, then act on what was read: choose the cheapest of 40 plans.
 *
 * The plans table starts far below the viewport with ten plans; ten more load each time its end comes into
 * view. The cheapest plan is in the fourth group of ten, and a featured plan's button comes first. The other
 * plans are not on the page until they are loaded, so no observation can show them early. No network, no
 * accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL =
  "In the All plans table, choose the plan with the lowest monthly price by pressing its Choose button. " +
  "More plans load as you scroll to the end of the table. Do not choose the featured plan unless it is the " +
  "cheapest. Stop when Plan chosen is shown.";

// The scripted policy's reference run only scrolls; it does not know the answer. verify() works out the
// expected plan from the page's full list, so reading this file does not give the answer away.
export const SCRIPT: ScriptStep[] = [{ operation: "SCROLL_DOWN" }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "plans_more.html")).href;
}

// The cheapest plan in the page's full list, loaded or not.
const LOWEST = "PLANS.reduce((best, plan) => (best === null || plan[2] < best[2] ? plan : best), null)?.[0] ?? null";

/** Reads which plan the page recorded. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const chosen = await browser.evaluate("document.body.dataset.chosen ?? null");
  const expected = await browser.evaluate(LOWEST);
  return { success: expected !== null && chosen === expected, evidence: { chosen, expected } };
}
