/** Choosing Chrome and profiles. The Windows Chrome is never started here. */

import { mkdirSync } from "node:fs";
import { expect, test, vi } from "vitest";
import {
  browserUrl,
  CHROMES,
  chooseChrome,
  chromeArgs,
  listProfiles,
  probes,
  profileDir,
} from "../src/engines/chrome.ts";
import { shellProbe } from "../src/engines/headless-shell.ts";
import { chooseEngine, ENGINE_CHOICES, hostName } from "../src/engines/index.ts";
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
  vi.spyOn(probes, "onWsl").mockReturnValue(true);
  vi.spyOn(probes, "windowsChrome").mockReturnValue("/mnt/c/chrome.exe");
}

test("auto uses windows only when mirrored", () => {
  wsl();
  const mode = vi.spyOn(probes, "networkingMode").mockReturnValue("mirrored");
  expect(chooseChrome("auto")).toEqual(["windows", null]);
  mode.mockReturnValue("nat");
  const [chrome, note] = chooseChrome("auto");
  expect(chrome).toBe("linux");
  expect(note).toContain("mirrored");
  expect(() => chooseChrome("windows")).toThrow(/mirrored/);
});

test("linux is always linux", () => {
  wsl();
  expect(chooseChrome("linux")).toEqual(["linux", null]);
});

test("auto off WSL is linux", () => {
  vi.spyOn(probes, "onWsl").mockReturnValue(false);
  expect(chooseChrome("auto")[0]).toBe("linux");
});

test("headless and profile arguments", () => {
  const args = chromeArgs("chrome", "C:\\p", { headed: false });
  expect(args[1]).toBe("--headless=new");
  expect(args).toContain("--user-data-dir=C:\\p");
  expect(args).toContain("--remote-debugging-port=0");
  expect(chromeArgs("chrome", "p", { headed: true })).not.toContain("--headless=new");
});

test("local files go through wsl.localhost", () => {
  vi.spyOn(probes, "toWindows").mockImplementation(
    (path: string) => `\\\\wsl.localhost\\Ubuntu${path.replaceAll("/", "\\")}`,
  );
  const url = browserUrl("file:///home/u/hotel.html?scenario=travel", "windows");
  expect(url).toBe("file://wsl.localhost/Ubuntu/home/u/hotel.html?scenario=travel");
  expect(browserUrl("https://example.com/", "windows")).toBe("https://example.com/");
  expect(browserUrl("file:///x.html", "linux")).toBe("file:///x.html");
});

test("saved profiles live under home", () => {
  vi.stubEnv("WEBHAND_HOME", tmpPath());
  expect(listProfiles("linux")).toEqual([]);
  mkdirSync(profileDir("linux", "work"), { recursive: true });
  expect(listProfiles("linux")).toEqual(["work"]);
  expect(() => profileDir("linux", "../escape")).toThrow(session.SessionError);
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

test("a session id names its own files; the default keeps the old names", () => {
  session.use();
  expect(session.id()).toBe("default");
  const base = session.tabPath();
  session.use("work-1");
  expect(session.tabPath()).not.toBe(base);
  expect(session.tabPath()).toMatch(/tab-work-1$/);
  session.use();
  expect(session.tabPath()).toMatch(/\/tab$/);
});

test("an id is letters, digits, - and _, and is found in the arguments", () => {
  for (const bad of ["", "../x", "a b", "x".repeat(41), "a/b"]) expect(() => session.use(bad)).toThrow(/--id/);
  session.use();
  expect(session.idFrom(["finish", "--id", "b", "--status", "done"])).toBe("b");
  expect(session.idFrom(["finish", "--id=c"])).toBe("c");
  expect(session.idFrom(["finish"])).toBe("default");
});

test.each(["lightpanda", "obscura"])("%s has no saved profile and no window", async (engine) => {
  await expect(session.startChrome({ engine, profile: "work" })).rejects.toThrow(/no saved profile/);
  await expect(session.startChrome({ engine, headed: true })).rejects.toThrow(/no window/);
});

test.each(["lightpanda", "obscura"])("a missing %s is an error, not a crash", async (engine) => {
  vi.stubEnv("PATH", tmpPath());
  vi.stubEnv("WEBHAND_OBSCURA", "");
  await expect(session.startChrome({ engine })).rejects.toThrow(new RegExp(`${engine} was not found`));
  vi.unstubAllEnvs();
});

test("hostName reads as the engine or as Chrome", () => {
  expect(hostName("obscura", "linux")).toBe("Obscura");
  expect(hostName("chrome", "linux")).toBe("linux Chrome");
  expect(hostName("chrome", "windows")).toBe("windows Chrome");
});

test("an engine is never a --chrome choice", () => {
  expect(CHROMES).toEqual(["auto", "linux", "windows"]);
  expect(ENGINE_CHOICES).toEqual([
    "auto",
    "chrome",
    "headless-shell",
    "lightpanda",
    "obscura",
    "browser-run",
    "kitesurf",
  ]);
  expect(() => chooseChrome("obscura")).toThrow(session.SessionError);
});

test("the headless shell has no window and no saved profile, and is not --chrome windows", async () => {
  const engine = "headless-shell";
  await expect(session.startChrome({ engine, headed: true })).rejects.toThrow(/no window/);
  await expect(session.startChrome({ engine, profile: "work" })).rejects.toThrow(/no saved profile/);
  await expect(session.startChrome({ engine, chrome: "windows" })).rejects.toThrow(/Linux only/);
});

test("a missing headless shell is an error, not a crash", async () => {
  vi.stubEnv("PATH", tmpPath());
  vi.stubEnv("WEBHAND_HEADLESS_SHELL", "");
  vi.stubEnv("PLAYWRIGHT_BROWSERS_PATH", tmpPath());
  await expect(session.startChrome({ engine: "headless-shell" })).rejects.toThrow(
    /chrome-headless-shell was not found/,
  );
  vi.unstubAllEnvs();
});

test("the headless shell gets the page size and no --headless flag; Chrome keeps its window size", () => {
  const shell = chromeArgs("shell", "p", { headed: false, shell: true });
  expect(shell).toContain("--window-size=1120,780");
  expect(shell).not.toContain("--headless=new");
  const chrome = chromeArgs("chrome", "p", { headed: false });
  expect(chrome).toContain("--window-size=1120,867");
  expect(chrome).toContain("--headless=new");
});

test("auto uses the headless shell for a run that needs no window or profile, and Chrome otherwise", () => {
  const shell = vi.spyOn(shellProbe, "binary").mockReturnValue("/x/chrome-headless-shell");
  const plain = { headed: false, profile: null, chrome: "auto" };
  expect(chooseEngine("auto", plain)).toBe("headless-shell");
  expect(chooseEngine("auto", { ...plain, chrome: "linux" })).toBe("headless-shell");
  expect(chooseEngine("auto", { ...plain, headed: true })).toBe("chrome");
  expect(chooseEngine("auto", { ...plain, profile: "work" })).toBe("chrome");
  expect(chooseEngine("auto", { ...plain, chrome: "windows" })).toBe("chrome"); // asked for, not just reachable
  shell.mockReturnValue(null);
  expect(chooseEngine("auto", plain)).toBe("chrome"); // no shell installed: what the run used before
  shell.mockReturnValue("/x/chrome-headless-shell");
  for (const named of ["chrome", "lightpanda", "obscura"]) expect(chooseEngine(named, plain)).toBe(named);
});
