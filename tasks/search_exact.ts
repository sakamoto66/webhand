/**
 * Find an item on a page whose search matches an item code only: add the Linen tote bag to the cart.
 *
 * Searching a name finds nothing ("No items found"); the aisle buttons list the items. The goal gives the name,
 * not the code. For the learning A/B: a fact of the service (browse by aisle) against none. No network.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Fieldnote Shop catalogue, add the Linen tote bag to the cart. Stop when Added to cart: Linen tote bag is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "CLICK", label: "Aisle: Bags" },
  { operation: "CLICK", label: "Add to cart: Linen tote bag" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "search_exact.html")).href;
}

/** Reads what the cart received. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const cart = (await browser.evaluate("document.body.dataset.cart ?? ''")) as string;
  return { success: cart === "Linen tote bag", evidence: { cart } };
}
