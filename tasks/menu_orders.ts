/**
 * The same eight pages as menu_invoice, a different goal: open the list of orders.
 *
 * The Orders page is one click from the top menu. A run that knows the site from a menu_invoice run is offered
 * More (the way that run took) on the start page, which does not serve this goal. For the stage 3 A/B of whether
 * what was learned leads a later run astray.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL = "On the Fieldnote site, open the list of orders. Stop when the Orders page is shown.";

export const SCRIPT: ScriptStep[] = [{ operation: "CLICK", label: "Orders" }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "menu_home.html")).href;
}

/** Reads which page is open. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const path = (await browser.evaluate("location.pathname")) as string;
  return { success: path.endsWith("/menu_orders.html"), evidence: { path } };
}
