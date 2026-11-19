/**
 * Place an order whose button stays disabled until the terms box is read to the end.
 *
 * Place order is disabled; reaching the end of the Terms of sale box (its last control is Print terms, which scrolls the box when pressed) enables it. The goal does not say
 * so. For the learning A/B: a fact of the service (read the terms to the end) against none. No network.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL = "On the Fieldnote Shop checkout page, place the order. Stop when Order placed is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "CLICK", label: "Print terms" },
  { operation: "CLICK", label: "Place order" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "terms_scroll.html")).href;
}

/** Reads whether the order was placed. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const placed = (await browser.evaluate("document.body.dataset.placed ?? ''")) as string;
  return { success: placed === "yes", evidence: { placed } };
}
