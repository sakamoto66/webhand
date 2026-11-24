/**
 * A value the plan may lack: request a quote.
 *
 * Name and Email are on the page. Pressing Request quote shows one more required field, Company code, and
 * refuses to go on without it. The goal gives the code, so Claude can supply it when asked. For the phase 2 A/B
 * (`answer --value` against replan); no network, no accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export const GOAL =
  "Request a quote as Mika Tanaka with the email mika@example.com: type the Name and Email, then press Request " +
  "quote. If a company code is asked for, it is KT-4821. Stop when Quote requested is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "TYPE_TEXT", label: "Name", text: "Mika Tanaka" },
  { operation: "TYPE_TEXT", label: "Email", text: "mika@example.com" },
  { operation: "CLICK", label: "Request quote" },
  { operation: "TYPE_TEXT", label: "Company code", text: "KT-4821" },
  { operation: "CLICK", label: "Request quote" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "needs_extra_value.html")).href;
}

/** Reads what the page received. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const raw = (await browser.evaluate("document.body.dataset.quote ?? null")) as string | null;
  const given = raw === null ? null : (JSON.parse(raw) as { name: string; email: string; code: string });
  const success =
    given?.name.trim() === "Mika Tanaka" &&
    given?.email.trim() === "mika@example.com" &&
    given?.code.trim() === "KT-4821";
  return { success, evidence: { submitted: given !== null, code_ok: given?.code.trim() === "KT-4821" } };
}
