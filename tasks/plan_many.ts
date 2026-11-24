/**
 * Read a long list, then act on what was read: choose the cheapest of 200 plans.
 *
 * A table of 200 plans, all in the page from the start, far longer than the read layer's limit. The cheapest
 * is near the end, and a featured plan's button comes first.
 * No network, no accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL =
  "In the All plans list, choose the plan with the lowest monthly price by pressing its Choose button. " +
  "Do not choose the featured plan unless it is the cheapest. Stop when Plan chosen is shown.";

// The scripted policy's reference run only scrolls; it does not know the answer. verify() works out the
// expected plan from the page's full list, so reading this file does not give the answer away.
export const SCRIPT: ScriptStep[] = [{ operation: "SCROLL_DOWN" }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "plans_many.html")).href;
}

// The cheapest plan in the page's full list, shown or not.
const LOWEST = "PLANS.reduce((best, plan) => (best === null || plan[2] < best[2] ? plan : best), null)?.[0] ?? null";

/** Reads which plan the page recorded. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const chosen = await browser.evaluate("document.body.dataset.chosen ?? null");
  const expected = await browser.evaluate(LOWEST);
  return { success: expected !== null && chosen === expected, evidence: { chosen, expected } };
}
