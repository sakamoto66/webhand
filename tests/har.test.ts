import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildPostData,
  extractResponseCookies,
  formatProtocol,
  HarCollector,
  isHttpUrl,
  MAX_BODY_BYTES,
  mergeHeaders,
  normalizeHeaders,
  parseQueryString,
  parseRequestCookies,
  parseSetCookie,
  resolveRedirectUrl,
  shouldCaptureBody,
  writeHarAtomic,
} from "../src/har.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("HAR helpers", () => {
  test("recognizes HTTP/HTTPS URLs and formats protocols", () => {
    expect(isHttpUrl("http://localhost:7780/admin")).toBe(true);
    expect(isHttpUrl("https://example.com/a?b=1")).toBe(true);
    expect(isHttpUrl("about:blank")).toBe(false);
    expect(isHttpUrl("data:text/html,hi")).toBe(false);
    expect(isHttpUrl("blob:http://localhost/123")).toBe(false);

    expect(formatProtocol(undefined)).toBe("HTTP/1.1");
    expect(formatProtocol("h2")).toBe("HTTP/2.0");
    expect(formatProtocol("h3")).toBe("HTTP/3.0");
    expect(formatProtocol("http/1.1")).toBe("HTTP/1.1");
    expect(formatProtocol("quic")).toBe("quic");
  });

  test("parses query strings, Set-Cookie, and Cookie headers", () => {
    expect(parseQueryString("http://localhost:7780/orders?from=02/01/2023&status=pending")).toEqual([
      { name: "from", value: "02/01/2023" },
      { name: "status", value: "pending" },
    ]);
    expect(parseQueryString("not a url")).toEqual([]);

    expect(
      parseSetCookie(
        "admin=abc123; Path=/admin; Domain=localhost; Expires=Wed, 22 Oct 2025 23:54:47 GMT; HttpOnly; Secure",
      ),
    ).toEqual({
      name: "admin",
      value: "abc123",
      path: "/admin",
      domain: "localhost",
      expires: "Wed, 22 Oct 2025 23:54:47 GMT",
      httpOnly: true,
      secure: true,
    });
    expect(parseSetCookie("empty=; Path=/")).toEqual({ name: "empty", value: "", path: "/" });
    expect(parseSetCookie("malformed")).toBeNull();

    const headers = normalizeHeaders({
      "Set-Cookie": "a=1; Path=/\nb=hello%20world; HttpOnly",
      "Content-Type": "application/json",
    });
    expect(headers).toHaveLength(3);
    expect(extractResponseCookies(headers)).toEqual([
      { name: "a", value: "1", path: "/" },
      { name: "b", value: "hello%20world", httpOnly: true },
    ]);

    expect(parseRequestCookies([{ name: "Cookie", value: "sid=xyz; theme=dark; bad" }])).toEqual([
      { name: "sid", value: "xyz" },
      { name: "theme", value: "dark" },
    ]);
  });

  test("merges ExtraInfo headers case-insensitively and resolves redirects", () => {
    const merged = mergeHeaders(
      [
        { name: "Accept", value: "*/*" },
        { name: "User-Agent", value: "Chrome" },
      ],
      [
        { name: "accept", value: "text/html" },
        { name: "sec-fetch-mode", value: "navigate" },
      ],
    );
    expect(merged).toEqual([
      { name: "User-Agent", value: "Chrome" },
      { name: "accept", value: "text/html" },
      { name: "sec-fetch-mode", value: "navigate" },
    ]);

    expect(resolveRedirectUrl("/admin/dashboard/", "http://localhost:7780/admin")).toBe(
      "http://localhost:7780/admin/dashboard/",
    );
    expect(resolveRedirectUrl("https://other.test/next", "http://localhost:7780/")).toBe("https://other.test/next");
    expect(resolveRedirectUrl("", "http://localhost:7780/")).toBe("");
    expect(resolveRedirectUrl(undefined, "http://localhost:7780/")).toBe("");
  });

  test("builds postData and filters response body capture by MIME, extension, and size", () => {
    expect(
      buildPostData("name=Alice&role=admin", [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }]),
    ).toEqual({
      mimeType: "application/x-www-form-urlencoded",
      text: "name=Alice&role=admin",
      params: [
        { name: "name", value: "Alice" },
        { name: "role", value: "admin" },
      ],
    });
    expect(buildPostData('{"ok":true}', [{ name: "content-type", value: "application/json" }])).toEqual({
      mimeType: "application/json",
      text: '{"ok":true}',
    });

    expect(shouldCaptureBody("http://localhost:7780/api/orders", "application/json; charset=utf-8", 512)).toBe(true);
    expect(shouldCaptureBody("http://localhost:7780/index.html", "text/html", 2048)).toBe(true);
    expect(shouldCaptureBody("http://localhost:7780/app.js", "application/javascript", 100)).toBe(false);
    expect(shouldCaptureBody("http://localhost:7780/logo.png", "image/png", 100)).toBe(false);
    expect(shouldCaptureBody("http://localhost:7780/style.css", "text/css", 100)).toBe(false);
    expect(shouldCaptureBody("http://localhost:7780/api/huge", "application/json", MAX_BODY_BYTES + 1)).toBe(false);
    expect(shouldCaptureBody("http://localhost:7780/api/raw", "", 100)).toBe(true);
  });
});

describe("HarCollector", () => {
  test("records GET, POST JSON, ExtraInfo arriving out of order, and response bodies", () => {
    const collector = new HarCollector({ browser: { name: "Chrome", version: "141.0" }, version: "0.5.0" });

    // Non-HTTP URL is ignored.
    expect(
      collector.onRequestWillBeSent("s1", {
        requestId: "r0",
        request: { url: "data:text/plain,hello", method: "GET" },
        timestamp: 10,
      }).entry,
    ).toBeNull();

    // ExtraInfo arrives BEFORE requestWillBeSent.
    collector.onRequestWillBeSentExtraInfo("s1", {
      requestId: "r1",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-user": "?1",
        cookie: "session=tok1",
      },
    });
    const first = collector.onRequestWillBeSent("s1", {
      requestId: "r1",
      request: {
        url: "http://localhost:7780/admin/sales/order/?status=complete",
        method: "GET",
        headers: { Referer: "http://localhost:7780/admin/" },
      },
      timestamp: 100,
      wallTime: 1_760_000_000,
    });
    expect(first.entry).not.toBeNull();
    expect(first.needsPostData).toBe(false);

    collector.onResponseReceived("s1", {
      requestId: "r1",
      timestamp: 100.1,
      response: { status: 200, statusText: "OK", headers: { "Content-Type": "text/html" }, protocol: "http/1.1" },
    });
    collector.onResponseReceivedExtraInfo("s1", {
      requestId: "r1",
      statusCode: 200,
      headers: { "Set-Cookie": "admin=abc%201; Path=/admin\nnotice=saved; Path=/" },
    });
    const done1 = collector.onLoadingFinished("s1", { requestId: "r1", timestamp: 100.25, encodedDataLength: 42 });
    expect(done1.shouldFetchBody).toBe(true);
    collector.setResponseBody(done1.entry as NonNullable<typeof done1.entry>, "<h1>Orders</h1>", false);

    // POST request with deferred postData + ExtraInfo arriving AFTER requestWillBeSent.
    const post = collector.onRequestWillBeSent("s1", {
      requestId: "r2",
      request: {
        url: "http://localhost:7780/api/items",
        method: "POST",
        headers: { "X-Requested-With": "XMLHttpRequest" },
        hasPostData: true,
      },
      timestamp: 101,
      wallTime: 1_760_000_001,
    });
    expect(post.needsPostData).toBe(true);
    collector.onRequestWillBeSentExtraInfo("s1", {
      requestId: "r2",
      headers: { "Content-Type": "application/json", Referer: "http://localhost:7780/admin/sales/order/" },
    });
    collector.setPostData(post.entry as NonNullable<typeof post.entry>, '{"qty":2}');
    collector.onResponseReceived("s1", {
      requestId: "r2",
      timestamp: 101.05,
      response: { status: 201, statusText: "Created", mimeType: "application/json", protocol: "h2" },
    });
    const done2 = collector.onLoadingFinished("s1", { requestId: "r2", timestamp: 101.08, encodedDataLength: 15 });
    expect(done2.shouldFetchBody).toBe(true);
    collector.setResponseBody(done2.entry as NonNullable<typeof done2.entry>, '{"created":1}', false);

    const har = collector.toHar();
    expect(har.log.version).toBe("1.2");
    expect(har.log.creator).toEqual({ name: "webhand", version: "0.5.0" });
    expect(har.log.browser).toEqual({ name: "Chrome", version: "141.0" });
    expect(har.log.entries).toHaveLength(2);

    const [e1, e2] = har.log.entries;
    expect(e1.request.queryString).toEqual([{ name: "status", value: "complete" }]);
    expect(e1.request.cookies).toEqual([{ name: "session", value: "tok1" }]);
    expect(e1.request.headers.find((h) => h.name === "sec-fetch-user")?.value).toBe("?1");
    expect(e1.response.cookies).toEqual([
      { name: "admin", value: "abc%201", path: "/admin" },
      { name: "notice", value: "saved", path: "/" },
    ]);
    expect(e1.response.content.text).toBe("<h1>Orders</h1>");
    expect(e1.time).toBe(250);

    expect(e2.request.postData).toEqual({ mimeType: "application/json", text: '{"qty":2}' });
    expect(e2.request.httpVersion).toBe("HTTP/2.0");
    expect(e2.response.status).toBe(201);
    expect(e2.response.content.text).toBe('{"created":1}');
  });

  test("records redirect chains with redirectURL and Set-Cookie from ExtraInfo", () => {
    const collector = new HarCollector();

    collector.onRequestWillBeSent("s1", {
      requestId: "redir",
      request: {
        url: "http://localhost:7780/login",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        postData: "user=alice",
      },
      timestamp: 10,
      wallTime: 1_760_000_010,
    });
    // Redirect hop arrives with redirectResponse on the next requestWillBeSent with same requestId.
    collector.onRequestWillBeSent("s1", {
      requestId: "redir",
      request: {
        url: "http://localhost:7780/dashboard",
        method: "GET",
        headers: { Accept: "text/html" },
      },
      timestamp: 10.05,
      wallTime: 1_760_000_010.05,
      redirectResponse: {
        status: 302,
        statusText: "Found",
        headers: { Location: "/dashboard" },
        protocol: "http/1.1",
      },
    });
    // Late ExtraInfo for the 302 redirect hop (contains Set-Cookie).
    collector.onResponseReceivedExtraInfo("s1", {
      requestId: "redir",
      statusCode: 302,
      headers: { "Set-Cookie": "sid=newsession; Path=/; HttpOnly" },
    });
    collector.onResponseReceived("s1", {
      requestId: "redir",
      timestamp: 10.1,
      response: { status: 200, statusText: "OK", headers: { "Content-Type": "text/html" } },
    });
    collector.onLoadingFinished("s1", { requestId: "redir", timestamp: 10.12, encodedDataLength: 10 });

    const { entries } = collector.toHar().log;
    expect(entries).toHaveLength(2);
    expect(entries[0].request.method).toBe("POST");
    expect(entries[0].response.status).toBe(302);
    expect(entries[0].response.redirectURL).toBe("http://localhost:7780/dashboard");
    expect(entries[0].response.cookies).toEqual([{ name: "sid", value: "newsession", path: "/", httpOnly: true }]);
    expect(entries[1].request.method).toBe("GET");
    expect(entries[1].request.url).toBe("http://localhost:7780/dashboard");
    expect(entries[1].response.status).toBe(200);
  });

  test("attaches late 302 responseReceivedExtraInfo to redirect hop even after 200 responseReceived", () => {
    const collector = new HarCollector();
    collector.onRequestWillBeSent("s1", {
      requestId: "r-race",
      request: { url: "http://localhost:7780/submit", method: "POST", postData: "a=1" },
      timestamp: 1,
    });
    collector.onRequestWillBeSent("s1", {
      requestId: "r-race",
      request: { url: "http://localhost:7780/done", method: "GET" },
      timestamp: 1.02,
      redirectResponse: { status: 302, statusText: "Found", headers: { Location: "/done" } },
    });
    // Destination 200 response arrives BEFORE the redirect's 302 ExtraInfo.
    collector.onResponseReceived("s1", {
      requestId: "r-race",
      timestamp: 1.04,
      response: { status: 200, statusText: "OK", headers: { "Content-Type": "text/html" } },
    });
    collector.onResponseReceivedExtraInfo("s1", {
      requestId: "r-race",
      statusCode: 302,
      headers: { "Set-Cookie": "session_id=late302; Path=/" },
    });
    collector.onResponseReceivedExtraInfo("s1", {
      requestId: "r-race",
      statusCode: 200,
      headers: { "X-Done": "1" },
    });
    collector.onLoadingFinished("s1", { requestId: "r-race", timestamp: 1.05, encodedDataLength: 5 });

    const { entries } = collector.toHar().log;
    expect(entries).toHaveLength(2);
    expect(entries[0].response.cookies).toEqual([{ name: "session_id", value: "late302", path: "/" }]);
    expect(entries[1].response.cookies).toEqual([]);
    expect(entries[1].response.headers.find((h) => h.name === "X-Done")?.value).toBe("1");
  });

  test("handles loadingFailed, base64 bodies, oversized bodies, and atomic 0600 writes", () => {
    const collector = new HarCollector();
    collector.onRequestWillBeSent("s1", {
      requestId: "fail1",
      request: { url: "http://localhost:7780/aborted", method: "GET" },
      timestamp: 1,
    });
    collector.onLoadingFailed("s1", { requestId: "fail1", timestamp: 1.05 });

    const ok = collector.onRequestWillBeSent("s1", {
      requestId: "b64",
      request: { url: "http://localhost:7780/api/b64", method: "GET" },
      timestamp: 2,
    });
    collector.onResponseReceived("s1", {
      requestId: "b64",
      timestamp: 2.02,
      response: { status: 200, mimeType: "application/json" },
    });
    collector.onLoadingFinished("s1", { requestId: "b64", timestamp: 2.03, encodedDataLength: 8 });
    const entry = ok.entry as NonNullable<typeof ok.entry>;
    collector.setResponseBody(entry, Buffer.from('{"a":1}').toString("base64"), true);
    // Oversized body is ignored.
    collector.setResponseBody(entry, "x".repeat(MAX_BODY_BYTES + 10), false);
    expect(entry.response.content.encoding).toBe("base64");

    const dir = mkdtempSync(join(tmpdir(), "webhand-har-test-"));
    temps.push(dir);
    const outPath = join(dir, "nested", "network.har");
    writeHarAtomic(outPath, collector.toHar());
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(outPath, "utf8"));
    expect(parsed.log.entries).toHaveLength(2);
    expect(parsed.log.entries[0].response.status).toBe(0);
    expect(parsed.log.entries[1].response.content.encoding).toBe("base64");
  });
});
