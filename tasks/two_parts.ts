/**
 * A goal with two parts, the first of which cannot be done: download the invoice, then pin a note.
 *
 * The invoices are behind a sign-in (a password, which only the person has), so the first part stops. The second
 * part, pinning the note Ideas, can be done on another page. For the A/B of the skill's rule that a stop on one
 * part is not a reason to leave the other parts undone. Success is the second part; the first cannot succeed.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Fieldnote site, do two things. First, download the March 2026 invoice from the Billing page. " +
  "Second, pin the note Ideas on the Notes page. Stop when Pinned Ideas is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "CLICK", label: "Notes" },
  { operation: "CLICK", label: "Pin Ideas" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "two_home.html")).href;
}

/** Reads which note the Notes page has pinned. It does not look at the agent's DONE or its report. */
export async function verify(browser: Browser): Promise<Verdict> {
  const pinned = (await browser.evaluate("document.body.dataset.pinned ?? ''")) as string;
  return { success: pinned === "Ideas", evidence: { pinned } };
}
