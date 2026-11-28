/**
 * Add one item deep in a 500-card catalog whose cards carry long descriptions: add Sage Cushion 420.
 *
 * Five hundred cards, each a link whose accessible name includes about 300 characters of Japanese description, and an
 * Add to cart button. Card 420 (Sage Cushion 420) sits well past MAX_BEYOND = 200 from y=0 and pushes the whole-page
 * state far above Jev's 24k token limit. No network, no accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL =
  "On the Catalog page, add one Sage Cushion 420 to the cart with its Add to cart button, and add nothing else. " +
  "Stop when Added Sage Cushion 420 to the cart is shown.";

export const SCRIPT: ScriptStep[] = [{ operation: "CLICK", label: "Add Sage Cushion 420 to cart" }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "catalog_deep.html")).href;
}

/** Reads the page's cart. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const raw = (await browser.evaluate("document.body.dataset.cart ?? null")) as string | null;
  const cart = raw === null ? [] : (JSON.parse(raw) as string[]);
  return { success: cart.length === 1 && cart[0] === "Sage Cushion 420", evidence: { cart } };
}
