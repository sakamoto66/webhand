/**
 * Keeping a run inside its hosts: CDP's Fetch pauses each request, redirect hops included, and a refused one is failed
 * before it is sent. Playwright's route does not see redirect hops.
 */

import type { CDPSession } from "playwright-core";
import { hostAllowed } from "../explore.ts";

/** Guards what the CDP session sees, of one resource type or of all, while the session lasts. */
export async function guardRequests(
  cdp: CDPSession,
  refuses: (url: string, resourceType: string) => boolean,
  resourceType?: "Document",
): Promise<void> {
  cdp.on("Fetch.requestPaused", (paused) => {
    const { requestId } = paused;
    const answer = refuses(paused.request.url, paused.resourceType)
      ? cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
      : cdp.send("Fetch.continueRequest", { requestId });
    answer.catch(() => {}); // A request left unanswered stays paused: nothing is sent.
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", ...(resourceType ? { resourceType } : {}) }] });
}

/**
 * allowed_domains: document requests outside the hosts are refused. A Chrome browser session covers every tab and
 * frame, new ones included; Lightpanda's page session covers its one page and the windows that page asks for.
 */
export function guardDocuments(cdp: CDPSession, allow: () => string[]): Promise<void> {
  return guardRequests(cdp, (url, type) => type === "Document" && !hostAllowed(url, allow()), "Document");
}
