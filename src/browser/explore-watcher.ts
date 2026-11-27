/**
 * Exploring (`--explore`): passive page anomaly watcher (console errors, pageerrors, 5xx, failed requests)
 * and out-of-scope host request blocker. Nothing here acts on a page.
 */

import type { BrowserContext, Browser as PlaywrightBrowser, Page as PlaywrightPage } from "playwright-core";
import { clip, dedupe, type Finding, hostAllowed, plainUrl } from "../explore.ts";
import { guardRequests } from "./request-guard.ts";

export class ExploreWatcher {
  private readonly found: Finding[] = [];

  /** Called before the connection opens any page. `open` are the tabs it already has. */
  async watch(
    browser: PlaywrightBrowser,
    context: BrowserContext,
    open: PlaywrightPage[],
    explore: { allow: string[] } | null,
  ): Promise<void> {
    if (!explore) return;
    const note = (finding: Finding) => this.found.push(finding);
    const watchPage = (page: PlaywrightPage) => {
      page.on("console", (message) => {
        // A failed resource is reported by its response or request already.
        if (message.type() === "error" && !/^Failed to load resource/.test(message.text())) {
          note({ signal: "console_error", url: plainUrl(page.url()), detail: clip(message.text()) });
        }
      });
      page.on("pageerror", (error) => {
        note({ signal: "pageerror", url: plainUrl(page.url()), detail: clip(error.message) });
      });
      page.on("response", (response) => {
        if (response.status() >= 500) {
          note({ signal: "http_5xx", url: plainUrl(response.url()), detail: "", status: response.status() });
        }
      });
      page.on("requestfailed", (request) => {
        const reason = request.failure()?.errorText ?? "";
        // Cancelled requests are what navigation does. Blocked ones are refusals of ours, reported once, as
        // out_of_scope; a refused redirect hop fails under the address that was first asked for.
        if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(reason)) return;
        note({ signal: "request_failed", url: plainUrl(request.url()), detail: clip(reason) });
      });
    };
    for (const page of context.pages()) watchPage(page);
    context.on("page", watchPage);
    const refuses = (url: string): boolean => {
      if (hostAllowed(url, explore.allow)) return false;
      note({ signal: "out_of_scope", url: plainUrl(url), detail: "" });
      return true;
    };
    await context.route("**/*", async (route) => {
      const request = route.request();
      return refuses(request.url()) ? route.abort("blockedbyclient") : route.continue();
    });
    // The route misses redirect hops. The browser session sees those of every document loaded from now on, new tabs
    // and workers included. A document an earlier command loaded is only seen by a session of its own page, or of its
    // own frame when that frame runs in another process.
    await guardRequests(await browser.newBrowserCDPSession(), refuses);
    for (const page of open) {
      await guardRequests(await context.newCDPSession(page), refuses);
      for (const frame of page.frames().filter((f) => f !== page.mainFrame())) {
        const session = await context.newCDPSession(frame).catch((error: Error) => {
          if (/does not have a separate CDP session/.test(error.message)) return null; // The page's session sees it.
          throw error;
        });
        if (session) await guardRequests(session, refuses);
      }
    }
  }

  /** What exploring noted since the last call, once each. */
  take(): Finding[] {
    return dedupe(this.found.splice(0));
  }
}
