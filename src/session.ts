/**
 * A Chrome that outlives each CLI call, plus the run state that must survive between calls.
 *
 * Two kinds of profile:
 * - new: a temporary folder, deleted when the run ends. Nothing is signed in.
 * - profile:NAME: a saved webhand profile. A person signs in once with `profile login`, and later
 *   runs reuse that sign-in. It is never the person's everyday Chrome profile.
 *
 * On WSL, Chrome can be the Windows one. It is reachable only with mirrored networking, because
 * Chrome serves its debugging port on the Windows loopback.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { chromium } from "playwright-core";
import { pyRepr, sleep } from "./py.ts";
import * as workspace from "./workspace.ts";

const STARTUP_MS = 15_000;
const PROFILE_NAME = /^[\p{L}\p{N}_-]+$/u;
export const CHROMES = ["auto", "linux", "windows"];
const WINDOWS_CHROME = [
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

/** Chrome cannot be started as asked. */
export class SessionError extends Error {
  override name = "SessionError";
}

// biome-ignore lint/suspicious/noExplicitAny: the session state is a JSON document shared by every command.
export type State = Record<string, any>;

export function home(): string {
  return join(workspace.home(), "state");
}

function path(): string {
  return join(home(), "session.json");
}

export function load(): State | null {
  return existsSync(path()) ? JSON.parse(readFileSync(path(), "utf8")) : null;
}

export function save(state: State): void {
  mkdirSync(home(), { recursive: true });
  const temporary = join(home(), "session.tmp");
  writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path());
}

export function clear(): void {
  rmSync(path(), { force: true });
}

/** 'new' gives null; 'profile:NAME' gives NAME. */
export function parseSession(spec: string): string | null {
  if (spec === "new") return null;
  const at = spec.indexOf(":");
  const kind = at < 0 ? spec : spec.slice(0, at);
  const name = at < 0 ? "" : spec.slice(at + 1);
  if (kind !== "profile" || !PROFILE_NAME.test(name)) {
    throw new SessionError(`Expected --session new or profile:NAME, got ${pyRepr(spec)}`);
  }
  return name;
}

// --- Windows Chrome from WSL ---------------------------------------------------------------

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function run(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): string {
  return execFileSync(command, args, { ...options, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

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
  if (!CHROMES.includes(choice)) throw new SessionError(`Unknown --chrome ${pyRepr(choice)}`);
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
  return join(home(), "profiles");
}

export function profileDir(chrome: string, name: string): string {
  if (!PROFILE_NAME.test(name)) throw new SessionError(`Invalid profile name: ${pyRepr(name)}`);
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

// --- Start and stop ------------------------------------------------------------------------

export function chromeArgs(executable: string, userDataDir: string, options: { headed: boolean }): string[] {
  const args = [
    executable,
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-crash-restore-bubble",
    "--window-size=1120,867", // The browser UI takes 87px; the page viewport is 1120x780.
    "about:blank",
  ];
  if (!options.headed) args.splice(1, 0, "--headless=new");
  return args;
}

async function reachable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function which(command: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const file = join(dir, command);
    if (dir && isFile(file)) return file;
  }
  return null;
}

/** Chrome processes this process started. Only these can be watched for exit directly. */
const children = new Map<number, ChildProcess>();

function childExited(pid: number): boolean | null {
  const child = children.get(pid);
  if (!child) return null;
  return child.exitCode !== null || child.signalCode !== null;
}

/** profile=null makes a new temporary folder. A saved profile is kept when the run ends. */
export async function startChrome(
  options: { headed?: boolean; profile?: string | null; chrome?: string } = {},
): Promise<State> {
  const headed = options.headed ?? false;
  const profile = options.profile ?? null;
  const chrome = options.chrome ?? "linux";
  let executable: string | null;
  if (chrome === "windows") {
    executable = probes.windowsChrome();
    if (!executable) throw new SessionError("chrome.exe was not found on Windows");
  } else {
    executable = which("google-chrome");
    if (!executable) throw new SessionError("google-chrome was not found");
  }
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
  const [command, ...args] = chromeArgs(executable, userDataDir, { headed });
  const child = spawn(command, args, {
    detached: true, // its own process group, so it outlives this CLI call and stops as a group
    stdio: "ignore",
    cwd: chrome === "windows" ? "/mnt/c" : undefined,
  });
  child.on("error", () => {});
  child.unref();
  const pid = child.pid as number;
  children.set(pid, child);
  const state: State = { pid, profile: folder, saved_profile: profile, chrome, headed };
  const portFile = join(folder, "DevToolsActivePort");
  const deadline = performance.now() + STARTUP_MS;
  while (performance.now() < deadline) {
    if (childExited(pid) && chrome === "linux") break;
    const text = isFile(portFile) ? readFileSync(portFile, "utf8") : "";
    if (text.trim()) {
      state.port = Number.parseInt(text.split(/\s/)[0], 10);
      if (chrome === "linux" || (await reachable(state.port))) return state;
    }
    await sleep(50);
  }
  await stopChrome(state);
  if (profile && childExited(pid)) {
    throw new SessionError(`Chrome exited at once. Is profile ${pyRepr(profile)} open in another Chrome window?`);
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

export async function stopChrome(state: State): Promise<void> {
  // A saved profile closes over CDP too, so Chrome writes its cookies before it exits.
  if ((state.chrome === "windows" || state.saved_profile) && state.port) {
    if (await closeOverCdp(state.port)) await exited(state.pid, 10_000); // Let Chrome finish writing first.
  }
  try {
    process.kill(-state.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  await exited(state.pid, state.chrome === "windows" ? 5000 : 2000);
  if (!state.saved_profile) rmSync(state.profile, { recursive: true, force: true });
}

function alive(pid: number): boolean {
  const own = childExited(pid);
  if (own !== null) return !own;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function exited(pid: number, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return false;
}

/** For `profile login`: returns when the person closes the window, or until() is true. */
export async function waitUntilClosed(state: State, until: () => boolean): Promise<void> {
  while (!until()) {
    if (state.chrome === "windows") {
      if (!(await reachable(state.port))) return;
    } else if (childExited(state.pid) !== false) {
      return;
    }
    await sleep(500);
  }
}

/** Removes a saved profile folder. */
export function deleteProfile(folder: string): void {
  rmSync(folder, { recursive: true, force: false });
}
