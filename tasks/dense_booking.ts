/**
 * Book on a crowded local page: 300 category links come before the booking form in the DOM.
 *
 * Without a view, the observation's 250-action limit is spent on the links and the form is cut.
 * No network, no bookings.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/tasks.ts";

const ARRIVAL = "12";
const DEPARTURE = "14";
const REGION = "30";
const GUEST = "Dense Tester";

export const GOAL =
  `In the Booking form, set Arrival to arrival ${ARRIVAL}, Departure to departure ${DEPARTURE}, ` +
  `and Region to region ${REGION}, enter ${GUEST} as Guest, and press Book. ` +
  "Do not touch any other field. Stop when Booking received is shown.";

export const SCRIPT: ScriptStep[] = [
  { operation: "SELECT", label: `arrival ${ARRIVAL}` },
  { operation: "SELECT", label: `departure ${DEPARTURE}` },
  { operation: "SELECT", label: `region ${REGION}` },
  { operation: "TYPE_TEXT", label: "Guest", text: GUEST },
  { operation: "CLICK", label: "Book" },
];

export function startUrl(root: string): string {
  return pathToFileURL(join(root, "tasks", "fixtures", "dense.html")).href;
}

/** Reads what the form submitted. It does not look at the agent's DONE or its history. */
export async function verify(browser: Browser): Promise<Verdict> {
  const state =
    (await browser.evaluate(
      "({booking: document.body.dataset.booking ?? null, result: document.getElementById('result')?.innerText})",
    )) || {};
  const booking = JSON.parse(state.booking || "{}");
  const checks = {
    submitted: state.result === "Booking received",
    arrival: booking.arrival === ARRIVAL,
    departure: booking.departure === DEPARTURE,
    region: booking.region === REGION,
    guest: booking.guest === GUEST,
  };
  return { success: Object.values(checks).every(Boolean), evidence: { checks, booking } };
}
