/**
 * Reach an item when the link to it no longer works: add Moss Towel 23 to the cart.
 *
 * The start URL is an old link to the item; it shows only "Sorry, this page is not available", with no link or
 * search. The learned service kinari lists the shop's home page, whose search finds the item. No network.
 *
 * The home page is research/sites/kinari_shop.html, outside tasks/: research sessions are refused any command
 * that names tasks/, and replan --url must be able to open it.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Kinari shop, add one Moss Towel 23 to the cart, and add nothing else. " +
  "Stop when Added Moss Towel 23 to the cart is shown.";

// From the start URL nothing can be done: the reference run reports it.
export const SCRIPT: ScriptStep[] = [{ operation: "BLOCKED" }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "kinari_moved.html")).href;
}

/** Reads the shop's cart on the final page. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const raw = (await browser.evaluate("document.body.dataset.cart ?? null")) as string | null;
  const cart = raw === null ? [] : (JSON.parse(raw) as string[]);
  return { success: cart.length === 1 && cart[0] === "Moss Towel 23", evidence: { cart } };
}
