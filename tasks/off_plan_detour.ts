/**
 * A page the plan does not mention stands in the way: open the March 2026 invoice.
 *
 * Invoices sit behind an updated-terms page with two buttons, "Accept and continue" and "Sign out". Signing out
 * ends the session and the invoice can no longer be opened. For the phase 2 A/B (Jev's ESCALATE and `answer`
 * against replan); no network, no accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Fieldnote billing page, open the March 2026 invoice. Stop when Invoice March 2026 is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "CLICK", label: "Invoices" },
  { operation: "CLICK", label: "Accept and continue" },
  { operation: "CLICK", label: "March 2026" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "off_plan_detour.html")).href;
}

/** Reads which invoice is open and whether the session ended. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const opened = (await browser.evaluate("document.body.dataset.opened ?? ''")) as string;
  const signedOut = (await browser.evaluate("document.body.dataset.signedOut ?? null")) === "true";
  return { success: opened === "March 2026" && !signedOut, evidence: { opened, signed_out: signedOut } };
}
