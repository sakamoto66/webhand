/**
 * The local Chrome, which is also what the headless shell launches. Two kinds of profile:
 * - new: a temporary folder, deleted when the run ends. Nothing is signed in.
 * - profile:NAME: a saved webhand profile. A person signs in once with `profile login`, and later
 *   runs reuse that sign-in. It is never the person's everyday Chrome profile.
 *
 * On WSL, Chrome can be the Windows one. It is reachable only with mirrored networking, because
 * Chrome serves its debugging port on the Windows loopback.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { Browser, type ViewChoice } from "../browser/index.ts";
import { SessionError } from "../core/errors.ts";
import { quote, sleep } from "../core/format.ts";
import * as workspace from "../core/workspace.ts";
import type { Driver } from "../ipc/remote.ts";
import type { State } from "../storage/session.ts";
import { childExited, children, exited, isFile, reachable, run, which } from "./process.ts";
import type { Engine, StartOptions } from "./types.ts";

/** Where Chrome runs (--chrome). */
export const CHROMES = ["auto", "linux", "windows"];
export const PROFILE_NAME = /^[\p{L}\p{N}_-]+$/u;
const WINDOWS_CHROME = [
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

/** What the host looks like. Tests replace these. */
export const probes = {
  onWsl(): boolean {
    return Boolean(process.env.WSL_INTEROP) || existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
  },
  windowsChrome(): string | null {
    return WINDOWS_CHROME.find(isFile) ?? null;
  },
  networkingMode(): string | null {
    try {
      return run("wslinfo", ["--networking-mode"], { timeout: 5000 }) || null;
    } catch {
      return null;
    }
  },
  toWindows(path: string): string {
    return run("wslpath", ["-w", path]);
  },
};

function windowsLocalAppData(): string {
  let folder = "";
  try {
    folder = run("cmd.exe", ["/c", "echo %LOCALAPPDATA%"], { cwd: "/mnt/c", timeout: 10_000 });
  } catch {
    folder = "";
  }
  if (!folder || folder.includes("%")) throw new SessionError("Could not read %LOCALAPPDATA% from Windows");
  return run("wslpath", ["-u", folder]);
}

/** Returns ['linux' or 'windows', a note for the person when auto fell back]. */
export function chooseChrome(choice: string): [string, string | null] {
  if (!CHROMES.includes(choice)) throw new SessionError(`Unknown --chrome ${quote(choice)}`);
  if (choice === "linux") return ["linux", null];
  let reason: string | null = null;
  if (!probes.onWsl()) reason = "not running on WSL";
  else if (!probes.windowsChrome()) reason = "chrome.exe was not found on Windows";
  else if (probes.networkingMode() !== "mirrored") {
    reason =
      "WSL networking is not mirrored, so the Windows Chrome debugging port is unreachable. " +
      "Add networkingMode=mirrored under [wsl2] in %USERPROFILE%\\.wslconfig and run wsl --shutdown";
  }
  if (reason === null) return ["windows", null];
  if (choice === "windows") throw new SessionError(`Cannot use the Windows Chrome: ${reason}`);
  return ["linux", `Using the Linux Chrome: ${reason}`];
}

function profilesRoot(chrome: string): string {
  if (chrome === "windows") return join(windowsLocalAppData(), "webhand", "profiles");
  return join(workspace.stateHome(), "profiles");
}

export function profileDir(chrome: string, name: string): string {
  if (!PROFILE_NAME.test(name)) throw new SessionError(`Invalid profile name: ${quote(name)}`);
  return join(profilesRoot(chrome), name);
}

export function listProfiles(chrome: string): string[] {
  const root = profilesRoot(chrome);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** A local file under WSL must be addressed through \\wsl.localhost for the Windows Chrome. */
export function browserUrl(url: string, chrome: string): string {
  if (chrome !== "windows" || !url.startsWith("file:///")) return url;
  const rest = url.slice("file://".length);
  const at = rest.indexOf("?");
  const local = at < 0 ? rest : rest.slice(0, at);
  const query = at < 0 ? "" : rest.slice(at + 1);
  const unc = probes.toWindows(local).replaceAll("\\", "/"); // //wsl.localhost/Ubuntu/...
  return `file:${unc}${query ? `?${query}` : ""}`;
}

export function chromeArgs(
  executable: string,
  userDataDir: string,
  options: { headed: boolean; shell?: boolean },
): string[] {
  const args = [
    executable,
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-crash-restore-bubble",
    // Chrome's window includes 87px of browser UI, so 1120x867 shows a 1120x780 page. The headless shell has no UI:
    // its window is the page, so it takes the page size. The same viewport, or the two read different elements.
    options.shell ? "--window-size=1120,780" : "--window-size=1120,867",
    "about:blank",
  ];
  if (!options.headed && !options.shell) args.splice(1, 0, "--headless=new");
  return args;
}

/** Starts a Chrome-family binary (Chrome, or the headless shell) on a fresh or saved profile and waits for its debugging port. */
export async function launchChrome(executable: string, options: StartOptions & { shell?: boolean }): Promise<State> {
  const { headed, profile, chrome, shell } = options;
  let folder: string;
  if (profile) {
    folder = profileDir(chrome, profile);
    mkdirSync(folder, { recursive: true });
    rmSync(join(folder, "DevToolsActivePort"), { force: true });
  } else if (chrome === "windows") {
    const temporary = join(windowsLocalAppData(), "webhand", "tmp");
    mkdirSync(temporary, { recursive: true });
    folder = mkdtempSync(join(temporary, "webhand-"));
  } else {
    folder = mkdtempSync(join(tmpdir(), "webhand-"));
  }
  const userDataDir = chrome === "windows" ? probes.toWindows(folder) : folder;
  const [command, ...args] = chromeArgs(executable, userDataDir, { headed, shell });
  const child = spawn(command, args, {
    detached: true, // its own process group, so it outlives this CLI call and stops as a group
    stdio: "ignore",
    cwd: chrome === "windows" ? "/mnt/c" : undefined,
  });
  child.on("error", () => {});
  child.unref();
  const pid = child.pid as number;
  children.set(pid, child);
  const state: State = {
    pid,
    profile: folder,
    saved_profile: profile,
    chrome,
    headed,
    ...(shell ? { engine: "headless-shell" } : {}),
  };
  const portFile = join(folder, "DevToolsActivePort");
  const deadline = performance.now() + options.startupMs;
  while (performance.now() < deadline) {
    if (childExited(pid) && chrome === "linux") break;
    const text = isFile(portFile) ? readFileSync(portFile, "utf8") : "";
    if (text.trim()) {
      state.port = Number.parseInt(text.split(/\s/)[0], 10);
      if (chrome === "linux" || (await reachable(state.port))) return state;
    }
    await sleep(50);
  }
  await stopLocal(state);
  if (profile && childExited(pid)) {
    throw new SessionError(`Chrome exited at once. Is profile ${quote(profile)} open in another Chrome window?`);
  }
  throw new SessionError("Chrome did not open a reachable debugging port");
}

/** The only way to close the Windows Chrome: the WSL pid is just the interop proxy. */
async function closeOverCdp(port: number): Promise<boolean> {
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
    try {
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send("Browser.close").catch(() => {});
    } finally {
      await browser.close().catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

/** Ends a browser process of this machine (Chrome, the headless shell, or an engine's daemon) and its temporary folder. */
export async function stopLocal(state: State): Promise<void> {
  // A saved profile closes over CDP too, so Chrome writes its cookies before it exits.
  if ((state.chrome === "windows" || state.saved_profile) && state.port) {
    if (await closeOverCdp(state.port)) await exited(state.pid, 10_000); // Let Chrome finish writing first.
  }
  try {
    process.kill(-state.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  if (!(await exited(state.pid, state.chrome === "windows" ? 5000 : 2000))) {
    // A browser slow to exit (a loaded machine) is still writing into its folder: end it, or the folder cannot go.
    try {
      process.kill(-state.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await exited(state.pid, 2000);
  }
  if (!state.saved_profile) {
    // A temporary folder is only tidying: it may not fail the call, which has done what it was asked to
    // (round of full test runs at once: ENOTEMPTY turned "the browser did not start" into a crash).
    try {
      rmSync(state.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Left behind in the temporary folder.
    }
  }
}

/** Connects to a local Chrome or headless-shell instance over its debugging port. */
export async function attachLocal(state: State, url: string | null, view?: ViewChoice | null): Promise<Driver> {
  return await Browser.open(url, {
    port: state.port,
    view,
    downloadDir: state.download_dir ?? null,
    explore: state.explore ?? null,
    allowedDomains: state.allowed_domains ?? null,
  });
}

export const chrome: Engine = {
  id: "chrome",
  label: null,
  capabilities: { localFiles: true, har: true, explore: true },
  async start(options) {
    let executable: string | null;
    if (options.chrome === "windows") {
      executable = probes.windowsChrome();
      if (!executable) throw new SessionError("chrome.exe was not found on Windows");
    } else {
      executable = which("google-chrome");
      if (!executable) throw new SessionError("google-chrome was not found");
    }
    return launchChrome(executable, options);
  },
  stop: stopLocal,
  attach: attachLocal,
};
