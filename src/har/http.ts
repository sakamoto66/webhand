/** Pure HTTP parsing and filtering helpers for HAR 1.2 construction. */

import type { HarCookie, HarHeader, HarPostData, HarQueryParam } from "./types.ts";

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

export function findHeader(headers: HarHeader[], lowerName: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === lowerName)?.value;
}

const COOKIE_STRING_ATTRS = new Set(["path", "domain", "expires"]);

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
    if (COOKIE_STRING_ATTRS.has(attrName)) cookie[attrName as "path" | "domain" | "expires"] = attrVal;
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
