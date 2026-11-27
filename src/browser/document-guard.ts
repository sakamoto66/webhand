/**
 * allowed_domains during a run: CDP's Fetch pauses each document request, redirect hops included, and one outside the
 * hosts is failed before it is sent. Playwright's route does not see redirect hops.
 */

import type { CDPSession } from "playwright-core";
import { hostAllowed } from "../explore.ts";

/**
 * Guards what the CDP session sees, while it lasts: a Chrome browser session covers every tab and frame, new ones
 * included; Lightpanda's page session covers its one page and the windows that page asks for.
 */
export async function guardDocuments(cdp: CDPSession, allow: () => string[]): Promise<void> {
  cdp.on("Fetch.requestPaused", ({ requestId, request, resourceType }) => {
    const refused = resourceType === "Document" && !hostAllowed(request.url, allow());
    const answer = refused
      ? cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
      : cdp.send("Fetch.continueRequest", { requestId });
    answer.catch(() => {}); // A request left unanswered stays paused: nothing is sent.
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document" }] });
}
