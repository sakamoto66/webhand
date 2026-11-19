/**
 * Finish a two-step form whose Next button is enabled by a box under a collapsed section.
 *
 * Next stays disabled until a name is typed and Send me a confirmation first (under More options) is ticked.
 * The goal does not say so. For the learning A/B: a fact of the service (open More options and tick it) against
 * none. No network.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Fieldnote alerts page, create an alert named Weekly report. Stop when Alert created is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "TYPE_TEXT", label: "Alert name", text: "Weekly report" },
  { operation: "CLICK", label: "More options" },
  { operation: "CLICK", label: "Send me a confirmation first" },
  { operation: "CLICK", label: "Next" },
  { operation: "CLICK", label: "Create alert" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "wizard_more.html")).href;
}

/** Reads the name the alert was created with. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const created = (await browser.evaluate("document.body.dataset.created ?? ''")) as string;
  return { success: created === "Weekly report", evidence: { created } };
}
