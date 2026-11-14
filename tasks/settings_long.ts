/**
 * Change one setting far down a long page and save: turn on Weekly summary.
 *
 * Thirty settings, each a heading, two lines of text, and a checkbox, fill about fifteen screens. Weekly summary
 * is the twenty-fourth; Save settings is at the bottom. Nothing else may change. No network, no accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Settings page, turn on Weekly summary, leave every other setting as it is, and press Save settings. " +
  "Stop when Settings saved is shown.";

// The scripted policy's reference run only scrolls; it does not know where the setting is.
export const SCRIPT: ScriptStep[] = [{ operation: "SCROLL_DOWN" }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "settings_long.html")).href;
}

/** Reads what the page saved. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const saved = (await browser.evaluate("document.body.dataset.saved ?? null")) as string | null;
  const initial = (await browser.evaluate("INITIAL")) as Record<string, boolean>;
  const expected: Record<string, boolean> = { ...initial, "Weekly summary": true };
  const given = saved === null ? null : (JSON.parse(saved) as Record<string, boolean>);
  const changed = given ? Object.keys(expected).filter((topic) => given[topic] !== expected[topic]) : null;
  return { success: given !== null && changed?.length === 0, evidence: { saved: given !== null, wrong: changed } };
}
