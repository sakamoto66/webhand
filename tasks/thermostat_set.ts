/**
 * Set a thermostat to a target value that is a distance of several presses away: 20.0 to 22.0 at 0.5 per press.
 *
 * The goal gives the value to reach, not a count of presses (the quantity stepper's shape, on another control and
 * with a different step). For the repeated-press A/B (round r41): the skill's one-step-per-press sentence against
 * none. No network.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL =
  "On the Fieldnote Home thermostat page, set the target temperature to 22 °C and press Save. Stop when Thermostat saved is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "CLICK", label: "Warmer" },
  { operation: "CLICK", label: "Warmer" },
  { operation: "CLICK", label: "Warmer" },
  { operation: "CLICK", label: "Warmer" },
  { operation: "CLICK", label: "Save" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "thermostat_set.html")).href;
}

/** Reads the temperature the page saved. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const temp = (await browser.evaluate("document.body.dataset.temp ?? ''")) as string;
  return { success: temp === "22.0", evidence: { temp } };
}
