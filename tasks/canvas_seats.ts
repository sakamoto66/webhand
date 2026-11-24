/**
 * The target is drawn on a canvas: reserve seat B4.
 *
 * The seat map is pixels on a canvas, so no seat is an element webhand can offer. The page says, in plain text,
 * that a list version is in the same folder (seats-list.html), where Seat B4 is a button. Both pages live in
 * research/sites, not tasks/: a session may not name tasks/ in a command, so it could not go to the list page there
 * (round 25 failed for that reason). For the A/B of showing Claude the parts webhand cannot see (a missing target
 * beside a canvas stops early, and WHY names the canvas).
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL = "On the Fieldnote seat selection page, reserve seat B4. Stop when Selected seat: B4 is shown.";

export const SCRIPT: ScriptStep[] = [{ operation: "CLICK", label: "Seat B4" }];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "research", "sites", "canvas_seats.html")).href;
}

/** Reads the seat the page received, on the map page or on the list page. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const seat = (await browser.evaluate("document.body.dataset.seat ?? ''")) as string;
  return { success: seat === "B4", evidence: { seat } };
}
