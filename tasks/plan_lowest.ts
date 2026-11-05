/**
 * Read a long page, then act on what was read: choose the cheapest of 40 plans.
 *
 * The plans table starts far below the viewport and is taller than it, and a featured plan's button comes
 * first. Without a read layer, Jev sees the table a screen at a time and must find the lowest price while
 * scrolling. No network, no accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

const CHEAPEST = "Flax"; // €12 a month; the next cheapest is €22.

export const GOAL =
  "In the All plans table, choose the plan with the lowest monthly price by pressing its Choose button. " +
  "Do not choose the featured plan unless it is the cheapest. Stop when Plan chosen is shown.";

export const SCRIPT: ScriptStep[] = [{ operation: "CLICK", label: `Choose ${CHEAPEST}` }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "plans.html")).href;
}

/** Reads which plan the page recorded. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const chosen = await browser.evaluate("document.body.dataset.chosen ?? null");
  return { success: chosen === CHEAPEST, evidence: { chosen, expected: CHEAPEST } };
}
