/**
 * Pick the fourth photo of a one-at-a-time carousel: it is reached by pressing Next photo three times.
 *
 * The goal names the photo's place in the list, not the number of presses. For the repeated-press A/B (rounds r39):
 * the skill's one-step-per-press sentence against none, on a control other than the quantity stepper. No network.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Fieldnote Gallery page, make the fourth photo of the list the cover photo: show it and press Use this photo. Stop when Cover saved is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "CLICK", label: "Next photo" },
  { operation: "CLICK", label: "Next photo" },
  { operation: "CLICK", label: "Next photo" },
  { operation: "CLICK", label: "Use this photo" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "carousel_next.html")).href;
}

/** Reads the photo the page saved as the cover. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const cover = (await browser.evaluate("document.body.dataset.cover ?? ''")) as string;
  return { success: cover === "Lantern festival", evidence: { cover } };
}
