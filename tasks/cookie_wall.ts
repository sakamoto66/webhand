/**
 * Change one email preference on a page that a cookie consent layer covers: turn on Weekly digest and save.
 *
 * A fixed layer over the whole page (not marked as a dialog) asks for cookie consent before anything under it can
 * be clicked; its buttons close it. The goal does not mention it. Nothing else may change. No network.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL =
  "On the Email preferences page, turn on Weekly digest, leave every other preference as it is, and press Save " +
  "preferences. Stop when Preferences saved is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "CLICK", label: "Only necessary" },
  { operation: "CLICK", label: "Weekly digest" },
  { operation: "CLICK", label: "Save preferences" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "cookie_wall.html")).href;
}

/** Reads what the page saved. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const saved = (await browser.evaluate("document.body.dataset.saved ?? null")) as string | null;
  const initial = (await browser.evaluate("INITIAL")) as Record<string, boolean>;
  const expected: Record<string, boolean> = { ...initial, "Weekly digest": true };
  const given = saved === null ? null : (JSON.parse(saved) as Record<string, boolean>);
  const wrong = given ? Object.keys(expected).filter((name) => given[name] !== expected[name]) : null;
  return { success: given !== null && wrong?.length === 0, evidence: { saved: given !== null, wrong } };
}
