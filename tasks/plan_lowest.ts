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

export const GOAL =
  "In the All plans table, choose the plan with the lowest monthly price by pressing its Choose button. " +
  "Do not choose the featured plan unless it is the cheapest. Stop when Plan chosen is shown.";

// The scripted policy's reference run. The expected plan is not written in this file: verify() works it out
// from the page, so reading this file does not give the answer away.
export const SCRIPT: ScriptStep[] = [{ operation: "CLICK", label: `Choose ${String.fromCharCode(70, 108, 97, 120)}` }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "plans.html")).href;
}

// The plan with the lowest price in the All plans table (the table that follows the "All plans" heading).
const LOWEST = `(() => {
  const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent.trim() === "All plans");
  let table = heading?.nextElementSibling;
  while (table && table.tagName !== "TABLE") table = table.nextElementSibling;
  let best = null;
  for (const row of table?.querySelectorAll("tr") ?? []) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 3) continue;
    const price = Number(cells[2].textContent.replace(/[^0-9.]/g, ""));
    if (best === null || price < best.price) best = { plan: cells[0].textContent.trim(), price };
  }
  return best?.plan ?? null;
})()`;

/** Reads which plan the page recorded. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const chosen = await browser.evaluate("document.body.dataset.chosen ?? null");
  const expected = await browser.evaluate(LOWEST);
  return { success: expected !== null && chosen === expected, evidence: { chosen, expected } };
}
