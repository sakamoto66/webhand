/** HAR 1.2 recording: data model, HTTP helpers, collector, CDP event routing, and sidecar lifecycle. */

export { type CdpSender, parseBrowser } from "./cdp-client.ts";
export { HarCollector, writeHarAtomic } from "./collector.ts";
export { createHarEventHandler } from "./events.ts";
export {
  buildPostData,
  extractResponseCookies,
  formatProtocol,
  isHttpUrl,
  MAX_BODY_BYTES,
  mergeHeaders,
  normalizeHeaders,
  parseQueryString,
  parseRequestCookies,
  parseSetCookie,
  resolveRedirectUrl,
  shouldCaptureBody,
} from "./http.ts";
export type { HarDocument } from "./types.ts";
