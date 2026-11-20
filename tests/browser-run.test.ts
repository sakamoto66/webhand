/** Cloudflare Browser Run: the API is mocked, so nothing here reaches Cloudflare. */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Browser } from "../src/browser.ts";
import * as session from "../src/session.ts";

const API = "https://api.cloudflare.com/client/v4/accounts/acct/browser-run/devtools/browser";

beforeEach(() => {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "secret-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("start creates a session with the longest keep_alive and saves no key", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(reply({ sessionId: "s1", webSocketDebuggerUrl: `wss://x/${"s1"}` }));
  const state = await session.startChrome({ engine: "browser-run" });
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe(`${API}?keep_alive=1200000`);
  expect(init?.method).toBe("POST");
  expect(init?.headers).toEqual({ Authorization: "Bearer secret-token" });
  expect(state).toMatchObject({ engine: "browser-run", session_id: "s1", cdp: "wss://x/s1", saved_profile: null });
  expect(state.pid).toBeUndefined();
  expect(JSON.stringify(state)).not.toContain("secret-token");
});

test("it has no saved profile and no window", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  await expect(session.startChrome({ engine: "browser-run", profile: "work" })).rejects.toThrow(/no saved profile/);
  await expect(session.startChrome({ engine: "browser-run", headed: true })).rejects.toThrow(/no window/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("without the account and key it is an error before any request", async () => {
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  const fetchMock = vi.spyOn(globalThis, "fetch");
  await expect(session.startChrome({ engine: "browser-run" })).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  ["an error answer", () => reply({}, 403), /answered 403/],
  ["an answer with no session", () => reply({ result: 1 }), /gave no session/],
])("a start that fails: %s", async (_name, answer, message) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(answer());
  await expect(session.startChrome({ engine: "browser-run" })).rejects.toThrow(message);
});

test("an unreachable API is a SessionError", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
  await expect(session.startChrome({ engine: "browser-run" })).rejects.toThrow(session.SessionError);
});

test("stop deletes the session and never throws", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({ status: "closing" }));
  await session.stopChrome({ engine: "browser-run", session_id: "s1" });
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe(`${API}/s1`);
  expect(init?.method).toBe("DELETE");
  fetchMock.mockRejectedValue(new Error("offline"));
  await expect(session.stopChrome({ engine: "browser-run", session_id: "s1" })).resolves.toBeUndefined();
});

test("auto never chooses it, and a named engine is taken as asked", () => {
  const options = { headed: false, profile: null, chrome: "auto" };
  expect(session.chooseEngine("browser-run", options)).toBe("browser-run");
  expect(session.chooseEngine("auto", options)).not.toBe("browser-run");
  expect(session.hostName("browser-run", "linux")).toBe("Cloudflare Browser Run");
});

test("a connection carries the key in the handshake, built from the environment", async () => {
  const seen: string[] = [];
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    seen.push(String(request.headers.authorization));
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await expect(
      Browser.open(null, { endpoint: { url: `ws://127.0.0.1:${port}/x`, headers: session.browserRunHeaders() } }),
    ).rejects.toThrow();
  } finally {
    server.close();
  }
  expect(seen).toEqual(["Bearer secret-token"]);
});

test("a rate-limited start says to wait", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("{}", { status: 429, headers: { "retry-after": "20" } }),
  );
  await expect(session.startChrome({ engine: "browser-run" })).rejects.toThrow(/answered 429.*wait 20 seconds/);
});
