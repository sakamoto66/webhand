/**
 * The order form is inside an iframe: type the name Mika Tanaka and place the order.
 *
 * The page itself holds only a heading and the frame, and the frame is another document (a file of its own, so
 * another origin). For the A/B of reading the elements of frames. The verifier reads the frame's own state.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "On the Fieldnote order page, place the order for the notebook with the name Mika Tanaka. Stop when Order placed for Mika Tanaka is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "TYPE_TEXT", label: "Name", text: "Mika Tanaka" },
  { operation: "CLICK", label: "Place order" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "frame_checkout.html")).href;
}

/** Reads the name the form received, in the frame itself. It does not look at the agent's DONE. */
export async function verify(browser: Browser): Promise<Verdict> {
  const frame = browser.frames().find((f) => f.url().endsWith("frame_checkout_form.html"));
  const ordered = frame ? ((await frame.evaluate("document.body.dataset.ordered ?? ''")) as string) : "";
  return { success: ordered === "Mika Tanaka", evidence: { ordered } };
}
