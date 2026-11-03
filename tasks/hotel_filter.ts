/** Local hotel search. The fixture comes from jev-ultrafast (MIT). No network, no bookings. */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/tasks.ts";

export const GOAL =
  "Find a stay in Lisbon in the Design category with free cancellation, " +
  "then open the page for Casa Flora. Stop on that page.";

export const SCRIPT: ScriptStep[] = [
  { operation: "TYPE_TEXT", label: "Destination", text: "Lisbon" },
  { operation: "CLICK", label: "Find stays" },
  { operation: "SELECT", label: "Design" },
  { operation: "CLICK", label: "Free cancellation" },
  { operation: "CLICK", label: "View Casa Flora" },
];

export function startUrl(root: string): string {
  return `${pathToFileURL(join(root, "tasks", "fixtures", "hotel.html")).href}?scenario=travel`;
}

/** Reads the final page directly. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const state = await browser.evaluate(
    "({heading: document.querySelector('h1')?.innerText, " +
      "note: document.querySelector('.fixture-note')?.innerText, hash: location.hash})",
  );
  const note: string = state?.note || "";
  const checks = {
    opened_casa_flora: state?.heading === "Casa Flora" && state.hash === "#casa-flora",
    category_design: note.includes("Design"),
    free_cancellation: note.includes("Free cancellation enabled"),
    destination_lisbon: note.includes("Destination Lisbon"),
  };
  return { success: Object.values(checks).every(Boolean), evidence: checks };
}
