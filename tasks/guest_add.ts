/**
 * Add three guests with a button that shows no count: Add guest is pressed once per guest.
 *
 * Each press only flashes "Guest added"; the party size is not on the page, so a plan cannot end a step on a number.
 * For the repeated-press A/B (round r40): the skill's one-step-per-press sentence against none, where the natural plan
 * is one step that says "three times". No network.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL =
  "On the Fieldnote Events RSVP page, add 3 guests to the party and press Confirm RSVP. Stop when RSVP confirmed is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "CLICK", label: "Add guest" },
  { operation: "CLICK", label: "Add guest" },
  { operation: "CLICK", label: "Add guest" },
  { operation: "CLICK", label: "Confirm RSVP" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "guest_add.html")).href;
}

/** Reads the party size the RSVP received. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const guests = (await browser.evaluate("document.body.dataset.guests ?? ''")) as string;
  return { success: guests === "3", evidence: { guests } };
}
