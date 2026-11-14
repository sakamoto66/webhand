/**
 * Add one item to the cart on a long catalog whose cards carry long descriptions: add Moss Towel 23.
 *
 * Four hundred cards, each a link whose name includes about 300 characters of Japanese description, and an Add
 * to cart button. Moss Towel 23 is a few screens down. With the whole page offered (flow v2), the request for
 * Jev is over its token limit unless it is fitted. No network, no accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Catalog page, add one Moss Towel 23 to the cart with its Add to cart button, and add nothing else. " +
  "Stop when Added Moss Towel 23 to the cart is shown.";

export const SCRIPT: ScriptStep[] = [{ operation: "CLICK", label: "Add Moss Towel 23 to cart" }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "catalog_big.html")).href;
}

/** Reads the page's cart. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const raw = (await browser.evaluate("document.body.dataset.cart ?? null")) as string | null;
  const cart = raw === null ? [] : (JSON.parse(raw) as string[]);
  return { success: cart.length === 1 && cart[0] === "Moss Towel 23", evidence: { cart } };
}
