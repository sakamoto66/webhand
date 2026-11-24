/**
 * Collect from a list that grows as it is scrolled: name every plan with 200 GB that costs less than €40.
 *
 * The plans table starts far below the viewport with ten plans; ten more load each time its end comes into
 * view. The matching plans are spread over the forty, most of them beyond the first ten, and the rows have no
 * buttons. The answer is typed into a box at the top of the page. No network, no accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL =
  "In the All plans table, find every plan with 200 GB of storage that costs less than €40 a month. More plans " +
  "load as you scroll to the end of the table. Type all of their names, separated by commas, into the Plan " +
  "names box at the top of the page and press Submit. Stop when Answer sent is shown.";

// The scripted policy's reference run only scrolls; it does not know the answer. verify() works out the
// expected names from the page's full list, so reading this file does not give the answer away.
export const SCRIPT: ScriptStep[] = [{ operation: "SCROLL_DOWN" }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "collect_more.html")).href;
}

const EXPECTED = 'PLANS.filter((plan) => plan[1] === "200 GB" && plan[2] < 40).map((plan) => plan[0])';

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
