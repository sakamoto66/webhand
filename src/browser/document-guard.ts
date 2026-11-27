/**
 * allowed_domains on an engine whose Playwright route misses redirect hops and new windows (Lightpanda): CDP's Fetch
 * pauses each document request, redirect hops included, and one outside the hosts is failed before it is sent.
 */

import type { CDPSession } from "playwright-core";
import { hostAllowed } from "../explore.ts";

/** Guards the session's page while this connection lasts. */
export async function guardDocuments(cdp: CDPSession, allow: () => string[]): Promise<void> {
  cdp.on("Fetch.requestPaused", ({ requestId, request, resourceType }) => {
    const refused = resourceType === "Document" && !hostAllowed(request.url, allow());
    const answer = refused
      ? cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
      : cdp.send("Fetch.continueRequest", { requestId });
    answer.catch(() => {}); // A request left unanswered stays paused: nothing is sent.
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
}
