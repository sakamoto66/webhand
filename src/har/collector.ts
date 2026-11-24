/** Stateful CDP Network.* event collector that builds a HAR 1.2 document. */

import { packageVersion, writeFileAtomic } from "../core/fs.ts";
import {
  buildPostData,
  extractResponseCookies,
  findHeader,
  formatProtocol,
  isHttpUrl,
  MAX_BODY_BYTES,
  mergeHeaders,
  normalizeHeaders,
  parseQueryString,
  parseRequestCookies,
  resolveRedirectUrl,
  shouldCaptureBody,
} from "./http.ts";
import type {
  CdpLoadingFailed,
  CdpLoadingFinished,
  CdpRequestExtraInfo,
  CdpRequestWillBeSent,
  CdpResponse,
  CdpResponseExtraInfo,
  CdpResponseReceived,
  HarDocument,
  HarEntry,
  HarHeader,
} from "./types.ts";

function elapsedMs(startTimestamp: number, endTimestamp: number): number {
  return Math.max(0, Math.round((endTimestamp - startTimestamp) * 1000 * 1000) / 1000);
}

interface ActiveRecord {
  entry: HarEntry;
  startTimestamp: number;
  hasReqExtra: boolean;
  hasResExtra: boolean;
  hasResponse: boolean;
}

/** Collects CDP Network.* events from one or more sessions and builds a HAR 1.2 document. */
export class HarCollector {
  private readonly entries: HarEntry[] = [];
  private readonly active = new Map<string, ActiveRecord>();
  /** FIFO queue of finalized redirect hops per requestId still waiting for responseReceivedExtraInfo. */
  private readonly pendingRedirects = new Map<string, ActiveRecord[]>();
  private readonly pendingReqExtra = new Map<string, HarHeader[][]>();
  private readonly pendingResExtra = new Map<string, CdpResponseExtraInfo[]>();
  private readonly browser?: { name: string; version: string };
  private readonly creatorVersion: string;

  constructor(options: { browser?: { name: string; version: string }; version?: string } = {}) {
    this.browser = options.browser;
    this.creatorVersion = options.version ?? packageVersion();
  }

  get count(): number {
    return this.entries.length;
  }

  private key(sessionId: string, requestId: string): string {
    return `${sessionId}:${requestId}`;
  }

  private updateResponseHeaders(
    record: ActiveRecord,
    rawHeaders?: Record<string, string>,
    forceRedirect = false,
  ): void {
    const headers = mergeHeaders(record.entry.response.headers, normalizeHeaders(rawHeaders));
    record.entry.response.headers = headers;
    record.entry.response.cookies = extractResponseCookies(headers);
    if (!record.entry.response.content.mimeType) {
      record.entry.response.content.mimeType = findHeader(headers, "content-type") ?? "";
    }
    const status = record.entry.response.status;
    if (status >= 300 && status < 400 && (forceRedirect || !record.entry.response.redirectURL)) {
      record.entry.response.redirectURL = resolveRedirectUrl(findHeader(headers, "location"), record.entry.request.url);
    }
  }

  private applyResponse(record: ActiveRecord, response: CdpResponse): void {
    record.entry.response.status = response.status ?? record.entry.response.status;
    record.entry.response.statusText = response.statusText ?? record.entry.response.statusText;
    record.entry.response.httpVersion = formatProtocol(response.protocol);
    if (response.mimeType) record.entry.response.content.mimeType = response.mimeType;
    this.updateResponseHeaders(record, response.headers, true);
    record.hasResponse = true;
  }

  private applyResponseExtra(record: ActiveRecord, extra: CdpResponseExtraInfo): void {
    if (extra.statusCode && record.entry.response.status === 0) {
      record.entry.response.status = extra.statusCode;
    }
    this.updateResponseHeaders(record, extra.headers);
    record.hasResExtra = true;
  }

  private takeMatchingRedirect(
    key: string,
    record: ActiveRecord | undefined,
    statusCode: number | undefined,
  ): ActiveRecord | null {
    const hops = this.pendingRedirects.get(key);
    if (!hops?.length) return null;
    // Prefer an exact status match when it differs from the current hop (e.g., late 301/302 after 200).
    let index = -1;
    if (statusCode != null && (!record?.hasResponse || statusCode !== record.entry.response.status)) {
      index = hops.findIndex((hop) => hop.entry.response.status === statusCode);
    }
    if (index < 0 && !record?.hasResponse) index = 0;
    if (index < 0) return null;
    const [matched] = hops.splice(index, 1);
    if (!hops.length) this.pendingRedirects.delete(key);
    return matched;
  }

  private finalizeRedirect(key: string, previous: ActiveRecord, params: CdpRequestWillBeSent): void {
    if (params.redirectResponse) {
      this.applyResponse(previous, params.redirectResponse);
      const queuedRes = this.pendingResExtra.get(key)?.shift();
      if (queuedRes) this.applyResponseExtra(previous, queuedRes);
      const elapsed = elapsedMs(previous.startTimestamp, params.timestamp);
      previous.entry.time = elapsed;
      previous.entry.timings.receive = elapsed;
      if (!previous.hasResExtra) {
        const hops = this.pendingRedirects.get(key) ?? [];
        hops.push(previous);
        this.pendingRedirects.set(key, hops);
      }
    }
    this.active.delete(key);
  }

  onRequestWillBeSent(
    sessionId: string,
    params: CdpRequestWillBeSent,
  ): { entry: HarEntry | null; needsPostData: boolean } {
    const key = this.key(sessionId, params.requestId);
    const previous = this.active.get(key);
    if (previous) this.finalizeRedirect(key, previous, params);

    if (!isHttpUrl(params.request.url)) {
      return { entry: null, needsPostData: false };
    }

    let headers = normalizeHeaders(params.request.headers);
    const queuedReq = this.pendingReqExtra.get(key)?.shift();
    if (queuedReq) headers = mergeHeaders(headers, queuedReq);

    const startedDateTime =
      typeof params.wallTime === "number" && Number.isFinite(params.wallTime)
        ? new Date(params.wallTime * 1000).toISOString()
        : new Date().toISOString();

    const postData =
      params.request.postData !== undefined ? buildPostData(params.request.postData, headers) : undefined;

    const entry: HarEntry = {
      startedDateTime,
      time: 0,
      request: {
        method: params.request.method,
        url: params.request.url,
        httpVersion: "HTTP/1.1",
        cookies: parseRequestCookies(headers),
        headers,
        queryString: parseQueryString(params.request.url),
        ...(postData ? { postData } : {}),
        headersSize: -1,
        bodySize: postData ? Buffer.byteLength(postData.text, "utf8") : -1,
      },
      response: {
        status: 0,
        statusText: "",
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: [],
        content: { size: 0, mimeType: "" },
        redirectURL: "",
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: -1, wait: -1, receive: 0 },
    };

    const record: ActiveRecord = {
      entry,
      startTimestamp: params.timestamp,
      hasReqExtra: Boolean(queuedReq),
      hasResExtra: false,
      hasResponse: false,
    };
    this.entries.push(entry);
    this.active.set(key, record);
    return {
      entry,
      needsPostData: Boolean(params.request.hasPostData && params.request.postData === undefined),
    };
  }

  onRequestWillBeSentExtraInfo(sessionId: string, params: CdpRequestExtraInfo): void {
    const extra = normalizeHeaders(params.headers);
    if (!extra.length) return;
    const key = this.key(sessionId, params.requestId);
    const record = this.active.get(key);
    if (record && !record.hasReqExtra) {
      record.entry.request.headers = mergeHeaders(record.entry.request.headers, extra);
      record.entry.request.cookies = parseRequestCookies(record.entry.request.headers);
      if (record.entry.request.postData && !record.entry.request.postData.mimeType) {
        record.entry.request.postData = buildPostData(record.entry.request.postData.text, record.entry.request.headers);
      }
      record.hasReqExtra = true;
      return;
    }
    const queue = this.pendingReqExtra.get(key) ?? [];
    queue.push(extra);
    this.pendingReqExtra.set(key, queue);
  }

  onResponseReceived(sessionId: string, params: CdpResponseReceived): void {
    const key = this.key(sessionId, params.requestId);
    const record = this.active.get(key);
    if (!record) return;
    this.applyResponse(record, params.response);
    if (!record.hasResExtra) {
      const queued = this.pendingResExtra.get(key)?.shift();
      if (queued) this.applyResponseExtra(record, queued);
    }
    record.entry.request.httpVersion = record.entry.response.httpVersion;
  }

  onResponseReceivedExtraInfo(sessionId: string, params: CdpResponseExtraInfo): void {
    const key = this.key(sessionId, params.requestId);
    const record = this.active.get(key);
    const redirect = this.takeMatchingRedirect(key, record, params.statusCode);
    if (redirect) {
      this.applyResponseExtra(redirect, params);
      return;
    }
    if (record && !record.hasResExtra) {
      this.applyResponseExtra(record, params);
      return;
    }
    const queue = this.pendingResExtra.get(key) ?? [];
    queue.push(params);
    this.pendingResExtra.set(key, queue);
  }

  onLoadingFinished(
    sessionId: string,
    params: CdpLoadingFinished,
  ): { entry: HarEntry | null; shouldFetchBody: boolean } {
    const key = this.key(sessionId, params.requestId);
    const record = this.active.get(key);
    if (!record) return { entry: null, shouldFetchBody: false };
    const elapsed = elapsedMs(record.startTimestamp, params.timestamp);
    record.entry.time = elapsed;
    record.entry.timings.receive = elapsed;
    if (typeof params.encodedDataLength === "number") {
      record.entry.response.bodySize = params.encodedDataLength;
      if (record.entry.response.content.size === 0) {
        record.entry.response.content.size = params.encodedDataLength;
      }
    }
    this.active.delete(key);
    this.pendingReqExtra.delete(key);
    this.pendingResExtra.delete(key);
    const fetchBody =
      record.entry.response.status !== 204 &&
      record.entry.response.status !== 304 &&
      shouldCaptureBody(record.entry.request.url, record.entry.response.content.mimeType, params.encodedDataLength);
    return { entry: record.entry, shouldFetchBody: fetchBody };
  }

  onLoadingFailed(sessionId: string, params: CdpLoadingFailed): void {
    const key = this.key(sessionId, params.requestId);
    const record = this.active.get(key);
    if (!record) return;
    const elapsed = elapsedMs(record.startTimestamp, params.timestamp);
    record.entry.time = elapsed;
    record.entry.timings.receive = elapsed;
    this.active.delete(key);
    this.pendingRedirects.delete(key);
    this.pendingReqExtra.delete(key);
    this.pendingResExtra.delete(key);
  }

  setPostData(entry: HarEntry, postData: string): void {
    entry.request.postData = buildPostData(postData, entry.request.headers);
    entry.request.bodySize = Buffer.byteLength(postData, "utf8");
  }

  setResponseBody(entry: HarEntry, body: string, base64Encoded = false): void {
    const bytes = Buffer.byteLength(body, base64Encoded ? "base64" : "utf8");
    if (bytes > MAX_BODY_BYTES) return;
    entry.response.content.size = bytes;
    entry.response.content.text = body;
    if (base64Encoded) entry.response.content.encoding = "base64";
  }

  toHar(): HarDocument {
    return {
      log: {
        version: "1.2",
        creator: { name: "webhand", version: this.creatorVersion },
        ...(this.browser ? { browser: this.browser } : {}),
        entries: this.entries,
      },
    };
  }
}

/** Writes a compact HAR 1.2 document atomically with owner-only permissions (0600). */
export function writeHarAtomic(path: string, document: HarDocument): void {
  writeFileAtomic(path, `${JSON.stringify(document)}\n`, { mode: 0o600 });
}
