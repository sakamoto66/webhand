/** Whether the pages sent something to a server: a request that is not a read. */

import type { BrowserContext, Request } from "playwright-core";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export class SentTracker {
  private sent = false;

  /** Watches every tab of the context, new ones included. */
  watch(context: BrowserContext): void {
    context.on("request", (request: Request) => {
      // A beacon (ping) reports on the visit; it is not what a press was for.
      if (!READS.has(request.method()) && request.resourceType() !== "ping") this.sent = true;
    });
  }

  /** Forgets what was sent before an action. */
  reset(): void {
    this.sent = false;
  }

  get any(): boolean {
    return this.sent;
  }
}
