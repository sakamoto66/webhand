/**
 * Exploring (`--explore`): passive page anomaly watcher (console errors, pageerrors, 5xx, failed requests)
 * and out-of-scope host request blocker. Nothing here acts on a page.
 */

import type { BrowserContext, Page as PlaywrightPage } from "playwright-core";
import { clip, dedupe, type Finding, hostAllowed, plainUrl } from "../explore.ts";

export class ExploreWatcher {
  private readonly found: Finding[] = [];
  /** Requests this run refused itself: their failure is the refusal, not a finding of its own. */
  private readonly refused = new WeakSet<object>();

  async watch(context: BrowserContext, explore: { allow: string[] } | null): Promise<void> {
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
        // Cancelled requests are what navigation does; a refusal of ours is reported once, as out_of_scope.
        if (this.refused.has(request) || /ERR_ABORTED/.test(reason)) return;
        note({ signal: "request_failed", url: plainUrl(request.url()), detail: clip(reason) });
      });
    };
    for (const page of context.pages()) watchPage(page);
    context.on("page", watchPage);
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (hostAllowed(request.url(), explore.allow)) return route.continue();
      this.refused.add(request);
      note({ signal: "out_of_scope", url: plainUrl(request.url()), detail: "" });
      return route.abort("blockedbyclient");
    });
  }

  /** What exploring noted since the last call, once each. */
  take(): Finding[] {
    return dedupe(this.found.splice(0));
  }
}
