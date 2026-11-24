/** Read-only environment diagnostic command (`webhand doctor`). Checks prerequisites without calling paid APIs or printing secrets. */

import type { Args } from "../args.ts";
import { SessionError } from "../core/errors.ts";
import { packageVersion } from "../core/fs.ts";
import { probes as chromeProbes, listProfiles, chooseChrome as pickChrome } from "../engines/chrome.ts";
import { shellProbe } from "../engines/headless-shell.ts";
import { which } from "../engines/process.ts";
import * as auth from "../storage/auth.ts";
import * as checkfile from "../storage/checkfile.ts";
import * as runbook from "../storage/runbook/index.ts";
import * as session from "../storage/session.ts";
import { FAILED, OK, print } from "./context.ts";
import { chromeOption } from "./options.ts";
import type { CommandDef } from "./types.ts";

const MIN_NODE_MAJOR = 22;

type DoctorStatus = "OK" | "WARN" | "FAIL" | "INFO";

interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  version: string;
  ready: boolean;
  checks: DoctorCheck[];
}

/** Host probes replaced in tests so diagnostics never depend on the runner's PATH or Node binary. */
export const doctorProbes = {
  nodeVersion(): string {
    return process.versions.node;
  },
  linuxChrome(): string | null {
    return which("google-chrome");
  },
};

function checkNode(): DoctorCheck {
  const raw = doctorProbes.nodeVersion();
  const major = Number.parseInt(raw.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    return { name: "node", status: "OK", detail: `v${raw} (>= ${MIN_NODE_MAJOR})` };
  }
  return {
    name: "node",
    status: "FAIL",
    detail: `v${raw} (requires Node.js ${MIN_NODE_MAJOR} or later)`,
    fix: `Install Node.js ${MIN_NODE_MAJOR} or later.`,
  };
}

function checkApiKey(): DoctorCheck {
  const key = process.env.TYPESAFE_API_KEY?.trim() ?? "";
  const model = process.env.TYPESAFE_MODEL?.trim();
  const modelLabel = model ? model : "jev-latest (default)";
  if (key.length > 0) {
    return { name: "typesafe_api_key", status: "OK", detail: `set (model: ${modelLabel})` };
  }
  return {
    name: "typesafe_api_key",
    status: "FAIL",
    detail: "not set",
    fix: "Export TYPESAFE_API_KEY in your shell profile (e.g. export TYPESAFE_API_KEY=...) and restart your coding agent.",
  };
}

function checkChrome(choice: string): { check: DoctorCheck; resolved: string | null } {
  let resolved: string;
  let note: string | null;
  try {
    [resolved, note] = pickChrome(choice);
  } catch (error) {
    const message = error instanceof SessionError ? error.message : String(error);
    return {
      resolved: null,
      check: {
        name: "chrome",
        status: "FAIL",
        detail: message,
        fix: "Use --chrome auto or --chrome linux, or enable mirrored networking on WSL for Windows Chrome.",
      },
    };
  }

  if (resolved === "windows") {
    const exe = chromeProbes.windowsChrome();
    if (exe) {
      return { resolved, check: { name: "chrome", status: "OK", detail: `windows (${exe})` } };
    }
    return {
      resolved: null,
      check: {
        name: "chrome",
        status: "FAIL",
        detail: "chrome.exe was not found on Windows",
        fix: "Install Google Chrome on Windows or pass --chrome linux.",
      },
    };
  }

  const bin = doctorProbes.linuxChrome();
  if (bin) {
    const suffix = chromeProbes.onWsl() && note ? ` — ${note}` : "";
    return { resolved, check: { name: "chrome", status: "OK", detail: `linux (${bin})${suffix}` } };
  }

  const detail = chromeProbes.onWsl() && note ? `google-chrome was not found (${note})` : "google-chrome was not found";
  const fix = chromeProbes.onWsl()
    ? "Install google-chrome in WSL, or install Chrome on Windows with networkingMode=mirrored in %USERPROFILE%\\.wslconfig."
    : "Install Google Chrome so `google-chrome` is available on PATH.";
  return { resolved: null, check: { name: "chrome", status: "FAIL", detail, fix } };
}

function checkHeadlessShell(): DoctorCheck {
  const bin = shellProbe.binary();
  if (bin) {
    return { name: "headless_shell", status: "OK", detail: `installed (${bin})` };
  }
  return { name: "headless_shell", status: "INFO", detail: "not installed (headless runs will use Chrome)" };
}

function checkWorkspace(resolvedChrome: string | null): DoctorCheck {
  const services = runbook.catalog();
  const procedures = services.flatMap((entry) => entry.procedures);
  const approved = procedures.filter((p) => p.status === "approved").length;
  const draft = procedures.length - approved;

  const checks = checkfile.catalog();
  const unusableChecks = checks.filter((entry) => !entry.file);

  let profiles = 0;
  if (resolvedChrome) {
    try {
      profiles = listProfiles(resolvedChrome).length;
    } catch {
      profiles = 0;
    }
  }
  const logins = auth.names().length;
  const active = session.active().length;

  const runbookPart =
    procedures.length > 0 ? `${procedures.length} runbooks (${approved} approved, ${draft} draft)` : "0 runbooks";
  const parts = [
    `${services.length} services`,
    runbookPart,
    `${profiles} profiles`,
    `${logins} logins`,
    `${active} active sessions`,
  ];

  if (unusableChecks.length > 0) {
    const names = unusableChecks.map((entry) => entry.name).join(", ");
    return {
      name: "workspace",
      status: "WARN",
      detail: `${parts.join(", ")}; ${unusableChecks.length} unusable check file(s): ${names}`,
      fix: "Run `webhand catalog` to inspect check file errors.",
    };
  }
  return { name: "workspace", status: "OK", detail: parts.join(", ") };
}

function runDoctor(chromeChoice: string): DoctorReport {
  const node = checkNode();
  const apiKey = checkApiKey();
  const { check: chrome, resolved } = checkChrome(chromeChoice);
  const shell = checkHeadlessShell();
  const ws = checkWorkspace(resolved);
  const checks = [node, apiKey, chrome, shell, ws];
  const ready = checks.every((item) => item.status !== "FAIL");
  return { version: packageVersion(), ready, checks };
}

function formatReport(report: DoctorReport): void {
  print(`webhand doctor (v${report.version})`);
  const nameWidth = Math.max(...report.checks.map((item) => item.name.length));
  for (const item of report.checks) {
    const tag = `[${item.status}]`.padEnd(6);
    print(`${tag} ${item.name.padEnd(nameWidth)}  ${item.detail}`);
    if (item.fix) print(`       fix: ${item.fix}`);
  }
  print();
  if (report.ready) {
    print("READY: environment looks good. Try: webhand catalog");
  } else {
    const failures = report.checks.filter((item) => item.status === "FAIL").length;
    print(`NOT READY: ${failures} check(s) failed. Fix the [FAIL] item(s) above and re-run webhand doctor.`);
  }
}

async function commandDoctor(args: Args): Promise<number> {
  const report = runDoctor(args.chrome);
  if (args.json) {
    print(JSON.stringify(report, null, 2));
  } else {
    formatReport(report);
  }
  return report.ready ? OK : FAILED;
}

export const doctorCommand: CommandDef = {
  name: "doctor",
  session: "none",
  spec: () => ({
    help: "Check Node.js, Chrome, TYPESAFE_API_KEY, and local workspace readiness",
    options: [chromeOption(), { name: "json", type: "boolean", default: false, help: "Print the report as JSON" }],
  }),
  run: commandDoctor,
};
