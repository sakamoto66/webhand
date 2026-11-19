/**
 * Filter a list by price on a page whose Max price field is read in cents without saying so.
 *
 * Typing 20 filters at 0.20 euros and shows No items; 2000 filters at 20 euros. The goal gives euros. For the
 * learning A/B: a fact of the service (the field is in cents) against none. No network.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Fieldnote Shop price filter, show only the items that cost 20 euros or less. Stop when Filter applied is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "TYPE_TEXT", label: "Max price", text: "2000" },
  { operation: "CLICK", label: "Apply filter" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "price_cents.html")).href;
}

/** Reads the limit the filter received. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const maxCents = (await browser.evaluate("document.body.dataset.maxCents ?? ''")) as string;
  return { success: maxCents === "2000", evidence: { maxCents } };
}
