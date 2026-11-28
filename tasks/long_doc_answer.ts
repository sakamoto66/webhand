/**
 * Read a 35,000+ character structured handbook, locate the final confirmation code in the bottom appendix,
 * and submit it in the form at the top of the page.
 *
 * The document contains 20 sections with headings, tables, checklists, and decoy reference tags so neither
 * TEXT_LIMIT (6,000 chars) nor READ_LIMIT (12,000 chars) includes the bottom appendix from y=0. No network, no accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL =
  "Read the Fieldnote Operations & Audit Handbook to find the final audit confirmation code in the Appendix " +
  "at the bottom of the document. Enter that code into the Confirmation code field at the top of the page " +
  "and press Submit. Stop when Answer submitted is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "TYPE_TEXT", label: "Confirmation code", text: "AUD-7492-QM" },
  { operation: "CLICK", label: "Submit" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "long_doc_answer.html")).href;
}

/** Reads what the form submitted and compares it to the page's expected code. It does not look at DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const answer = (await browser.evaluate("document.body.dataset.answer ?? null")) as string | null;
  const expected = (await browser.evaluate("window.EXPECTED_CODE ?? null")) as string | null;
  const success = answer !== null && expected !== null && answer.trim() === expected;
  return { success, evidence: { answer, expected } };
}
