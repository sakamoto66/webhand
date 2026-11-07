/**
 * Collect from a list on another page: name every plan with 200 GB that costs less than €40.
 *
 * The task starts on a home page with four popular plans, cards like those of the full list (one of them
 * matches), and links to the All plans page, which is collect_cards: forty cards and the answer box at its top.
 * Collecting on the home page finds one plan of the four. No network, no accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Fieldnote site, find every plan with 200 GB of storage that costs less than €40 a month; all plans " +
  "are listed on the All plans page. Type all of their names, separated by commas, into the Plan names box at " +
  "the top of that page and press Submit. Stop when Answer sent is shown.";

// The scripted policy's reference run only scrolls; it does not know the answer. verify() works out the
// expected names from the page's full list, so reading this file does not give the answer away.
export const SCRIPT: ScriptStep[] = [{ operation: "SCROLL_DOWN" }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "collect_nav.html")).href;
}

// The All plans page holds the full list; on any other page there is no answer to check.
const EXPECTED =
  'typeof PLANS === "undefined" ? [] : PLANS.filter((plan) => plan[1] === "200 GB" && plan[2] < 40).map((plan) => plan[0])';

const names = (text: string) =>
  text
    .split(/[,;\n]|\band\b/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

/** Reads the names the page received. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const answer = (await browser.evaluate("document.body.dataset.answer ?? null")) as string | null;
  const expected = ((await browser.evaluate(EXPECTED)) as string[]).map((name) => name.toLowerCase()).sort();
  const given = [...new Set(names(answer ?? ""))].sort();
  const success = answer !== null && given.length === expected.length && given.every((name, i) => name === expected[i]);
  return { success, evidence: { given, expected } };
}
