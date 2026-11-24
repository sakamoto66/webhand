/** Tests for `webhand doctor`: environment diagnostics without network calls or secret leakage. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FAILED, OK } from "../src/commands/context.ts";
import { type DoctorReport, doctorProbes } from "../src/commands/doctor.ts";
import { probes as chromeProbes } from "../src/engines/chrome.ts";
import { shellProbe } from "../src/engines/headless-shell.ts";
import * as auth from "../src/storage/auth.ts";
import * as runbook from "../src/storage/runbook/index.ts";
import { cli } from "./helpers.ts";

beforeEach(() => {
  const emptyCwd = join(process.env.WEBHAND_HOME as string, "cwd");
  mkdirSync(emptyCwd, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(emptyCwd);
  vi.spyOn(doctorProbes, "nodeVersion").mockReturnValue("24.1.0");
  vi.spyOn(doctorProbes, "linuxChrome").mockReturnValue("/usr/bin/google-chrome");
  vi.spyOn(chromeProbes, "onWsl").mockReturnValue(false);
  vi.spyOn(chromeProbes, "windowsChrome").mockReturnValue(null);
  vi.spyOn(chromeProbes, "networkingMode").mockReturnValue(null);
  vi.spyOn(shellProbe, "binary").mockReturnValue("/opt/chrome-headless-shell");
  vi.stubEnv("TYPESAFE_API_KEY", "ts_secret_should_never_be_printed");
  vi.stubEnv("TYPESAFE_MODEL", "");
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("doctor reports READY when all prerequisites pass and never prints the API key", async () => {
  const { code, out } = await cli("doctor");
  expect(code).toBe(OK);
  expect(out).toContain("webhand doctor");
  expect(out).toContain("[OK]");
  expect(out).toContain("node");
  expect(out).toContain("v24.1.0 (>= 22)");
  expect(out).toContain("typesafe_api_key");
  expect(out).toContain("set (model: jev-latest (default))");
  expect(out).toContain("linux (/usr/bin/google-chrome)");
  expect(out).toContain("installed (/opt/chrome-headless-shell)");
  expect(out).toContain("READY: environment looks good.");
  expect(out).not.toContain("ts_secret_should_never_be_printed");
});

test("doctor --json returns structured checks without leaking secrets", async () => {
  vi.stubEnv("TYPESAFE_MODEL", "jev-custom");
  const { code, out } = await cli("doctor", "--json");
  expect(code).toBe(OK);
  expect(out).not.toContain("ts_secret_should_never_be_printed");
  const report = JSON.parse(out) as DoctorReport;
  expect(report.ready).toBe(true);
  expect(report.checks.map((c) => c.name)).toEqual([
    "node",
    "typesafe_api_key",
    "chrome",
    "headless_shell",
    "workspace",
  ]);
  const apiCheck = report.checks.find((c) => c.name === "typesafe_api_key");
  expect(apiCheck?.detail).toBe("set (model: jev-custom)");
});

test("doctor fails when Node.js is below 22 or TYPESAFE_API_KEY is missing", async () => {
  vi.spyOn(doctorProbes, "nodeVersion").mockReturnValue("20.11.0");
  vi.stubEnv("TYPESAFE_API_KEY", "   ");
  const { code, out } = await cli("doctor");
  expect(code).toBe(FAILED);
  expect(out).toContain("[FAIL] node");
  expect(out).toContain("requires Node.js 22 or later");
  expect(out).toContain("[FAIL] typesafe_api_key");
  expect(out).toContain("NOT READY: 2 check(s) failed.");
});

test("doctor reports missing Linux Chrome and failed --chrome windows clearly", async () => {
  vi.spyOn(doctorProbes, "linuxChrome").mockReturnValue(null);
  const linux = await cli("doctor", "--chrome", "linux");
  expect(linux.code).toBe(FAILED);
  expect(linux.out).toContain("[FAIL] chrome");
  expect(linux.out).toContain("google-chrome was not found");
  expect(linux.out).toContain("fix:");

  const windows = await cli("doctor", "--chrome", "windows");
  expect(windows.code).toBe(FAILED);
  expect(windows.out).toContain("Cannot use the Windows Chrome: not running on WSL");
});

test("doctor handles WSL mirrored Windows Chrome and WSL fallback to Linux Chrome", async () => {
  vi.spyOn(chromeProbes, "onWsl").mockReturnValue(true);
  vi.spyOn(chromeProbes, "windowsChrome").mockReturnValue("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe");
  vi.spyOn(chromeProbes, "networkingMode").mockReturnValue("mirrored");
  const mirrored = await cli("doctor", "--json");
  expect(mirrored.code).toBe(OK);
  const mirroredReport = JSON.parse(mirrored.out) as DoctorReport;
  expect(mirroredReport.checks.find((c) => c.name === "chrome")?.detail).toContain("windows (");

  vi.spyOn(chromeProbes, "networkingMode").mockReturnValue("nat");
  const fallback = await cli("doctor", "--json");
  expect(fallback.code).toBe(OK);
  const fallbackReport = JSON.parse(fallback.out) as DoctorReport;
  expect(fallbackReport.checks.find((c) => c.name === "chrome")?.detail).toContain("WSL networking is not mirrored");

  vi.spyOn(doctorProbes, "linuxChrome").mockReturnValue(null);
  const neither = await cli("doctor", "--json");
  expect(neither.code).toBe(FAILED);
  const neitherReport = JSON.parse(neither.out) as DoctorReport;
  expect(neitherReport.checks.find((c) => c.name === "chrome")?.fix).toContain("networkingMode=mirrored");
});

test("doctor marks missing headless shell as INFO and summarizes workspace and unusable checks", async () => {
  vi.spyOn(shellProbe, "binary").mockReturnValue(null);
  // Save one auth login (must only report count, never cookie values).
  auth.save("demo", {
    cookies: [
      {
        name: "sid",
        value: "top-secret-cookie",
        domain: "example.test",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [],
  });
  // Create one approved runbook in user scope.
  const serviceDir = join(runbook.root("user"), "demo-svc");
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(
    join(serviceDir, "task.toml"),
    'status = "approved"\ngoal = "Open home"\nstart_url = "https://example.test"\n\n[[steps]]\ninstruction = "Wait"\n',
  );
  // Create one malformed check file to trigger WARN.
  const badChecksDir = join(process.env.WEBHAND_HOME as string, "checks", "broken");
  mkdirSync(badChecksDir, { recursive: true });
  writeFileSync(join(badChecksDir, "bad.toml"), "not = [valid toml\n");

  const { code, out } = await cli("doctor");
  expect(code).toBe(OK);
  expect(out).toContain("[INFO] headless_shell");
  expect(out).toContain("not installed (headless runs will use Chrome)");
  expect(out).toContain("[WARN] workspace");
  expect(out).toContain("1 services, 1 runbooks (1 approved, 0 draft), 0 profiles, 1 logins, 0 active sessions");
  expect(out).toContain("1 unusable check file(s): broken/bad");
  expect(out).not.toContain("top-secret-cookie");
});
