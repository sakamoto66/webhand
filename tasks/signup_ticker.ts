/**
 * Fill a short form while part of it keeps changing: sign up for the newsletter.
 *
 * Inside the form, a tip rotates and a countdown ticks every 400 ms, as a carousel or a timer would. Name and
 * Email are typed, then Sign up is pressed. No network, no accounts.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

export const GOAL =
  "Sign up for the newsletter as Mika Tanaka with the email mika@example.com: type the Name and Email, then " +
  "press Sign up. Stop when Thanks for signing up is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "TYPE_TEXT", label: "Name", text: "Mika Tanaka" },
  { operation: "TYPE_TEXT", label: "Email", text: "mika@example.com" },
  { operation: "CLICK", label: "Sign up" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "signup_ticker.html")).href;
}

/** Reads what the page received. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const raw = (await browser.evaluate("document.body.dataset.signup ?? null")) as string | null;
  const given = raw === null ? null : (JSON.parse(raw) as { name: string; email: string });
  const success = given?.name.trim() === "Mika Tanaka" && given?.email.trim() === "mika@example.com";
  return { success, evidence: { submitted: given !== null, name_ok: given?.name.trim() === "Mika Tanaka" } };
}
