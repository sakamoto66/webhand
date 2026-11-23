/**
 * HAR 1.2 recording over Chrome's browser-level CDP.
 *
 * HarCollector turns CDP Network.* events into a standard HAR 1.2 document (matching what
 * WebArena-Verified's NetworkEventEvaluator reads: request headers with ExtraInfo, postData,
 * redirect chains with redirectURL, Set-Cookie parsed into response.cookies, and text/JSON
 * response bodies). startHarRecorder / stopHarRecorder run src/har-daemon.ts as a detached
 * sidecar for the life of a session so traffic between CLI commands and across tabs is kept.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childExited, children, exited, listening } from "./engines/process.ts";
import { SessionError } from "./errors.ts";
import { sleep } from "./format.ts";
import { lines } from "./remote.ts";

/** Largest response body kept inline in the HAR (bytes). Larger payloads are left out. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const STATIC_ASSET_RE = /\.(?:css|js|mjs|png|jpe?g|gif|svg|woff2?|ttf|eot|ico|webp|avif|mp4|webm|mp3|wav|pdf|zip)$/i;

const TEXT_MIME_PATTERNS = [
  "application/json",
  "+json",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/html",
  "text/plain",
  "text/xml",
  "text/csv",
  "application/xml",
  "+xml",
];

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface HarQueryParam {
  name: string;
  value: string;
}

export interface HarPostData {
  mimeType: string;
  text: string;
  params?: { name: string; value: string }[];
}

interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: "base64";
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: HarCookie[];
    headers: HarHeader[];
    queryString: HarQueryParam[];
    postData?: HarPostData;
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: HarCookie[];
    headers: HarHeader[];
    content: HarContent;
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
}

export interface HarDocument {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    browser?: { name: string; version: string };
    entries: HarEntry[];
  };
}

/** Session state stored when --har is active. */
export interface HarState {
  path: string;
  pid: number;
  socket: string;
  dir: string;
}

export interface HarStopResult {
  entries: number;
  error?: string;
}

/** Subset of CDP Network.Request fields used to build a HAR entry. */
interface CdpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
}

/** Subset of CDP Network.Response fields used to build a HAR entry. */
export interface CdpResponse {
  url?: string;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  mimeType?: string;
  protocol?: string;
}

export interface CdpRequestWillBeSent {
  requestId: string;
  request: CdpRequest;
  timestamp: number;
  wallTime?: number;
  redirectResponse?: CdpResponse;
}

export interface CdpRequestExtraInfo {
  requestId: string;
  headers?: Record<string, string>;
}

export interface CdpResponseReceived {
  requestId: string;
  timestamp: number;
  response: CdpResponse;
}

export interface CdpResponseExtraInfo {
  requestId: string;
  headers?: Record<string, string>;
  statusCode?: number;
}

export interface CdpLoadingFinished {
  requestId: string;
  timestamp: number;
  encodedDataLength?: number;
}

export interface CdpLoadingFailed {
  requestId: string;
  timestamp: number;
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function formatProtocol(protocol?: string): string {
  if (!protocol) return "HTTP/1.1";
  const lower = protocol.toLowerCase();
  if (lower === "h2") return "HTTP/2.0";
  if (lower === "h3") return "HTTP/3.0";
  if (lower.startsWith("http/")) return protocol.toUpperCase();
  return protocol;
}

export function parseQueryString(url: string): HarQueryParam[] {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/** Turns a CDP header map into HAR name/value pairs, splitting multi-line Set-Cookie headers. */
export function normalizeHeaders(raw?: Record<string, string>): HarHeader[] {
  if (!raw) return [];
  const out: HarHeader[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (value == null) continue;
    const text = String(value);
    if (name.toLowerCase() === "set-cookie") {
      for (const part of text.split(/\r?\n/)) {
        const trimmed = part.trim();
        if (trimmed) out.push({ name, value: trimmed });
      }
    } else {
      out.push({ name, value: text });
    }
  }
  return out;
}

/** Merges ExtraInfo headers over base headers (case-insensitive; Set-Cookie lists replace as a group). */
export function mergeHeaders(base: HarHeader[], extra: HarHeader[]): HarHeader[] {
  if (!extra.length) return base;
  const extraNames = new Set(extra.map((h) => h.name.toLowerCase()));
  const kept = base.filter((h) => !extraNames.has(h.name.toLowerCase()));
  return [...kept, ...extra];
}

function findHeader(headers: HarHeader[], lowerName: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === lowerName)?.value;
}

/** Parses one Set-Cookie header value into a HAR cookie object. */
export function parseSetCookie(headerValue: string): HarCookie | null {
  const parts = headerValue.split(";");
  const first = parts[0]?.trim() ?? "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const cookie: HarCookie = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim(),
  };
  if (!cookie.name) return null;
  for (const rawAttr of parts.slice(1)) {
    const attr = rawAttr.trim();
    if (!attr) continue;
    const at = attr.indexOf("=");
    const attrName = (at < 0 ? attr : attr.slice(0, at)).trim().toLowerCase();
    const attrVal = at < 0 ? "" : attr.slice(at + 1).trim();
    if (attrName === "path") cookie.path = attrVal;
    else if (attrName === "domain") cookie.domain = attrVal;
    else if (attrName === "expires") cookie.expires = attrVal;
    else if (attrName === "httponly") cookie.httpOnly = true;
    else if (attrName === "secure") cookie.secure = true;
  }
  return cookie;
}

export function extractResponseCookies(headers: HarHeader[]): HarCookie[] {
  const cookies: HarCookie[] = [];
  for (const header of headers) {
    if (header.name.toLowerCase() !== "set-cookie") continue;
    const parsed = parseSetCookie(header.value);
    if (parsed) cookies.push(parsed);
  }
  return cookies;
}

export function parseRequestCookies(headers: HarHeader[]): HarCookie[] {
  const cookies: HarCookie[] = [];
  for (const header of headers) {
    if (header.name.toLowerCase() !== "cookie") continue;
    for (const pair of header.value.split(";")) {
      const trimmed = pair.trim();
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      cookies.push({ name: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() });
    }
  }
  return cookies;
}

export function resolveRedirectUrl(location: string | undefined, requestUrl: string): string {
  const trimmed = location?.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed, requestUrl).href;
  } catch {
    return trimmed;
  }
}

export function buildPostData(text: string, headers: HarHeader[]): HarPostData {
  const mimeType = findHeader(headers, "content-type") ?? "";
  const postData: HarPostData = { mimeType, text };
  if (mimeType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    postData.params = [...new URLSearchParams(text).entries()].map(([name, value]) => ({ name, value }));
  }
  return postData;
}

export function shouldCaptureBody(url: string, mimeType: string, encodedDataLength?: number): boolean {
  if (encodedDataLength != null && encodedDataLength > MAX_BODY_BYTES) return false;
  try {
    if (STATIC_ASSET_RE.test(new URL(url).pathname)) return false;
  } catch {
    return false;
  }
  const lower = mimeType.toLowerCase();
  if (!lower) return true;
  return TEXT_MIME_PATTERNS.some((pattern) => lower.includes(pattern));
}

function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
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
  private readonly lastRedirect = new Map<string, ActiveRecord>();
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

  private applyResponse(record: ActiveRecord, response: CdpResponse): void {
    const headers = mergeHeaders(record.entry.response.headers, normalizeHeaders(response.headers));
    const status = response.status ?? record.entry.response.status;
    record.entry.response.status = status;
    record.entry.response.statusText = response.statusText ?? record.entry.response.statusText;
    record.entry.response.httpVersion = formatProtocol(response.protocol);
    record.entry.response.headers = headers;
    record.entry.response.cookies = extractResponseCookies(headers);
    const mimeType = response.mimeType || findHeader(headers, "content-type") || "";
    record.entry.response.content.mimeType = mimeType;
    if (status >= 300 && status < 400) {
      record.entry.response.redirectURL = resolveRedirectUrl(findHeader(headers, "location"), record.entry.request.url);
    }
    record.hasResponse = true;
  }

  private applyResponseExtra(record: ActiveRecord, extra: CdpResponseExtraInfo): void {
    const headers = mergeHeaders(record.entry.response.headers, normalizeHeaders(extra.headers));
    if (extra.statusCode && record.entry.response.status === 0) {
      record.entry.response.status = extra.statusCode;
    }
    record.entry.response.headers = headers;
    record.entry.response.cookies = extractResponseCookies(headers);
    if (!record.entry.response.content.mimeType) {
      record.entry.response.content.mimeType = findHeader(headers, "content-type") ?? "";
    }
    const status = record.entry.response.status;
    if (status >= 300 && status < 400 && !record.entry.response.redirectURL) {
      record.entry.response.redirectURL = resolveRedirectUrl(findHeader(headers, "location"), record.entry.request.url);
    }
    record.hasResExtra = true;
  }

  onRequestWillBeSent(
    sessionId: string,
    params: CdpRequestWillBeSent,
  ): { entry: HarEntry | null; needsPostData: boolean } {
    const key = this.key(sessionId, params.requestId);
    const previous = this.active.get(key);
    if (previous) {
      if (params.redirectResponse) {
        this.applyResponse(previous, params.redirectResponse);
        const queuedRes = this.pendingResExtra.get(key)?.shift();
        if (queuedRes) this.applyResponseExtra(previous, queuedRes);
        const elapsed = Math.max(0, Math.round((params.timestamp - previous.startTimestamp) * 1000 * 1000) / 1000);
        previous.entry.time = elapsed;
        previous.entry.timings.receive = elapsed;
        this.lastRedirect.set(key, previous);
      }
      this.active.delete(key);
    }

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
    const redirect = this.lastRedirect.get(key);
    // For redirects, responseReceivedExtraInfo(3xx) can arrive after requestWillBeSent(redirectResponse)
    // and even after responseReceived(200) of the redirected hop under load.
    const matchesRedirect =
      redirect &&
      !redirect.hasResExtra &&
      (!record?.hasResponse ||
        (params.statusCode != null &&
          params.statusCode === redirect.entry.response.status &&
          params.statusCode !== record.entry.response.status));
    if (matchesRedirect) {
      this.applyResponseExtra(redirect, params);
      this.lastRedirect.delete(key);
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
    const elapsed = Math.max(0, Math.round((params.timestamp - record.startTimestamp) * 1000 * 1000) / 1000);
    record.entry.time = elapsed;
    record.entry.timings.receive = elapsed;
    if (typeof params.encodedDataLength === "number") {
      record.entry.response.bodySize = params.encodedDataLength;
      if (record.entry.response.content.size === 0) {
        record.entry.response.content.size = params.encodedDataLength;
      }
    }
    this.active.delete(key);
    if (this.lastRedirect.get(key)?.hasResExtra) this.lastRedirect.delete(key);
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
    const elapsed = Math.max(0, Math.round((params.timestamp - record.startTimestamp) * 1000 * 1000) / 1000);
    record.entry.time = elapsed;
    record.entry.timings.receive = elapsed;
    this.active.delete(key);
    this.lastRedirect.delete(key);
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

/** Writes a HAR document atomically with owner-only permissions (0600). */
export function writeHarAtomic(path: string, document: HarDocument): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

// --- Sidecar lifecycle ---------------------------------------------------------------------

const DEFAULT_STARTUP_MS = Number(process.env.WEBHAND_STARTUP_MS) || 15_000;
const STOP_TIMEOUT_MS = 10_000;

/** har-daemon.ts in dev/tests, or har-daemon.js once built. */
function harDaemonScript(): string {
  const ts = import.meta.url.endsWith(".ts");
  return fileURLToPath(new URL(ts ? "./har-daemon.ts" : "./har-daemon.js", import.meta.url));
}

/** Spawns the detached CDP HAR recorder sidecar and waits until it is attached and listening. */
export async function startHarRecorder(
  port: number,
  harPath: string,
  startupMs: number = DEFAULT_STARTUP_MS,
): Promise<HarState> {
  const dir = mkdtempSync(join(tmpdir(), "webhand-har-"));
  const socket = join(dir, "har.sock");
  const child = spawn(process.execPath, [harDaemonScript(), socket, String(port), harPath], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  const pid = child.pid as number;
  children.set(pid, child);
  const state: HarState = { path: harPath, pid, socket, dir };
  const deadline = performance.now() + startupMs;
  while (performance.now() < deadline) {
    if (childExited(pid)) break;
    if (await listening(socket)) return state;
    await sleep(50);
  }
  await killHarSidecar(state);
  throw new SessionError("HAR recorder did not attach to Chrome");
}

async function sendStop(socketPath: string): Promise<HarStopResult> {
  return await new Promise<HarStopResult>((resolve, reject) => {
    const client = connect(socketPath);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("HAR recorder timed out while flushing")));
    }, STOP_TIMEOUT_MS);
    client.once("connect", () => {
      client.write(`${JSON.stringify({ cmd: "stop" })}\n`);
    });
    client.on(
      "data",
      lines((line) => {
        try {
          const reply = JSON.parse(line) as { ok?: boolean; entries?: number; error?: string };
          if (reply.ok) finish(() => resolve({ entries: reply.entries ?? 0 }));
          else finish(() => reject(new Error(reply.error ?? "HAR recorder failed to save")));
        } catch (error) {
          finish(() => reject(error as Error));
        }
      }),
    );
    client.once("error", (error) => finish(() => reject(error)));
    client.once("close", () => finish(() => reject(new Error("HAR recorder closed before replying"))));
  });
}

async function killHarSidecar(har: HarState): Promise<void> {
  try {
    process.kill(-har.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  if (!(await exited(har.pid, 2000))) {
    try {
      process.kill(-har.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await exited(har.pid, 2000);
  }
  try {
    rmSync(har.dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of temp socket folder.
  }
}

/** Tells the HAR sidecar to flush pending bodies, write the HAR file, and exit. Must run before Chrome stops. */
export async function stopHarRecorder(har: HarState): Promise<HarStopResult> {
  try {
    const result = await sendStop(har.socket);
    await exited(har.pid, 3000);
    return result;
  } catch (error) {
    return { entries: 0, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await killHarSidecar(har);
  }
}
