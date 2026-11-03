/** Choosing Chrome and profiles. The Windows Chrome is never started here. */

import { mkdirSync } from "node:fs";
import { expect, test, vi } from "vitest";
import * as session from "../src/session.ts";
import { tmpPath } from "./helpers.ts";

test("session spec", () => {
  expect(session.parseSession("new")).toBeNull();
  expect(session.parseSession("profile:work")).toBe("work");
  for (const bad of ["profile:", "profile:../x", "attach:9222", "default"]) {
    expect(() => session.parseSession(bad)).toThrow(session.SessionError);
  }
});

function wsl() {
  vi.spyOn(session.probes, "onWsl").mockReturnValue(true);
  vi.spyOn(session.probes, "windowsChrome").mockReturnValue("/mnt/c/chrome.exe");
}

test("auto uses windows only when mirrored", () => {
  wsl();
  const mode = vi.spyOn(session.probes, "networkingMode").mockReturnValue("mirrored");
  expect(session.chooseChrome("auto")).toEqual(["windows", null]);
  mode.mockReturnValue("nat");
  const [chrome, note] = session.chooseChrome("auto");
  expect(chrome).toBe("linux");
  expect(note).toContain("mirrored");
  expect(() => session.chooseChrome("windows")).toThrow(/mirrored/);
});

test("linux is always linux", () => {
  wsl();
  expect(session.chooseChrome("linux")).toEqual(["linux", null]);
});

test("auto off WSL is linux", () => {
  vi.spyOn(session.probes, "onWsl").mockReturnValue(false);
  expect(session.chooseChrome("auto")[0]).toBe("linux");
});

test("headless and profile arguments", () => {
  const args = session.chromeArgs("chrome", "C:\\p", { headed: false });
  expect(args[1]).toBe("--headless=new");
  expect(args).toContain("--user-data-dir=C:\\p");
  expect(args).toContain("--remote-debugging-port=0");
  expect(session.chromeArgs("chrome", "p", { headed: true })).not.toContain("--headless=new");
});

test("local files go through wsl.localhost", () => {
  vi.spyOn(session.probes, "toWindows").mockImplementation(
    (path: string) => `\\\\wsl.localhost\\Ubuntu${path.replaceAll("/", "\\")}`,
  );
  const url = session.browserUrl("file:///home/u/hotel.html?scenario=travel", "windows");
  expect(url).toBe("file://wsl.localhost/Ubuntu/home/u/hotel.html?scenario=travel");
  expect(session.browserUrl("https://example.com/", "windows")).toBe("https://example.com/");
  expect(session.browserUrl("file:///x.html", "linux")).toBe("file:///x.html");
});

test("saved profiles live under home", () => {
  vi.stubEnv("WEBHAND_HOME", tmpPath());
  expect(session.listProfiles("linux")).toEqual([]);
  mkdirSync(session.profileDir("linux", "work"), { recursive: true });
  expect(session.listProfiles("linux")).toEqual(["work"]);
  expect(() => session.profileDir("linux", "../escape")).toThrow(session.SessionError);
});

test("an attached browser disconnects without closing Chrome or its page", async () => {
  const { Browser } = await import("../src/browser.ts");
  const chrome = await session.startChrome();
  try {
    const first = await Browser.open("data:text/html,<title>kept</title>", { port: chrome.port });
    await first.close();
    const second = await Browser.open(null, { port: chrome.port });
    try {
      expect(await second.page.title()).toBe("kept");
    } finally {
      await second.close();
    }
  } finally {
    await session.stopChrome(chrome);
  }
});
