/**
 * Set a quantity on a page whose field ignores typing: order 3 Notebooks.
 *
 * The Quantity field shows what is typed, then puts back the stepper's own count when it is left; only Increase
 * quantity and Decrease quantity change the count the order uses. The goal does not say so. For the learning A/B:
 * a fact of the service (use the stepper buttons) against none. No network.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL =
  "On the Fieldnote Shop Notebook page, order 3 Notebooks: set the quantity to 3 and press Place order. Stop when Order placed is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "CLICK", label: "Increase quantity" },
  { operation: "CLICK", label: "Increase quantity" },
  { operation: "CLICK", label: "Place order" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "qty_stepper.html")).href;
}

/** Reads the quantity the order received. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const order = (await browser.evaluate("document.body.dataset.order ?? ''")) as string;
  return { success: order === "3", evidence: { order } };
}
