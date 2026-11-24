/**
 * Register a guest in a form that a link opens in a new tab.
 *
 * Without tab switching, the form is never observed. No network, no registrations.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

const GUEST = "Tab Tester";

export const GOAL =
  `Open the guest form from the Event desk page. It opens in a new tab. ` +
  `Enter ${GUEST} as Guest and press Register. Stop when Registration received is shown.`;

export const SCRIPT: ScriptStep[] = [
  { operation: "CLICK", label: "Open guest form" },
  { operation: "TAB_2" },
  { operation: "TYPE_TEXT", label: "Guest", text: GUEST },
  { operation: "CLICK", label: "Register" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "tab_start.html")).href;
}

/** Reads what the form submitted, in whichever tab it is. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  let registration: { guest?: string } | null = null;
  let result: string | null = null;
  for (const page of browser.context.pages()) {
    const state = (await page
      .evaluate(
        "({registration: document.body?.dataset.registration ?? null, result: document.getElementById('result')?.innerText ?? null})",
      )
      .catch(() => null)) as { registration: string | null; result: string | null } | null;
    if (state?.registration) {
      registration = JSON.parse(state.registration);
      result = state.result;
    }
  }
  const checks = { submitted: result === "Registration received", guest: registration?.guest === GUEST };
  return { success: Object.values(checks).every(Boolean), evidence: { checks, registration } };
}
