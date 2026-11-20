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
import { type AddressInfo, connect, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startBrowserRun, stopBrowserRun } from "./browser-run.ts";
import { hostName, isCloud, isDaemon, rejectWindowAndProfile } from "./engines.ts";
import { SessionError } from "./errors.ts";
import { quote, sleep } from "./format.ts";
import * as workspace from "./workspace.ts";

/** How long a browser may take to start. Tests set WEBHAND_STARTUP_MS higher: several suites at once load the machine. */
const STARTUP_MS = Number(process.env.WEBHAND_STARTUP_MS) || 15_000;
const PROFILE_NAME = /^[\p{L}\p{N}_-]+$/u;
/** Where Chrome runs (--chrome). */
export const CHROMES = ["auto", "linux", "windows"];
const WINDOWS_CHROME = [
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

export { SessionError };

// biome-ignore lint/suspicious/noExplicitAny: the session state is a JSON document shared by every command.
export type State = Record<string, any>;

export function home(): string {
  return join(workspace.home(), "state");
}

export const DEFAULT_ID = "default";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
let currentId = DEFAULT_ID;

/** Which session the commands that follow work on. Several can run at once, each with its own Chrome and state. */
export function use(id: string = DEFAULT_ID): void {
  if (!ID_PATTERN.test(id))
    throw new SessionError(`Expected --id of letters, digits, - or _ (up to 40), got ${quote(id)}`);
  currentId = id;
}

export function id(): string {
  return currentId;
}

/** The value of --id (or --id=ID) in the arguments, for callers that look at the session before main() does. */
export function idFrom(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--id") return argv[i + 1] ?? "";
    if (argv[i].startsWith("--id=")) return argv[i].slice("--id=".length);
  }
  return DEFAULT_ID;
}

/** The default session keeps the file names it always had. */
function file(stem: string, extension = ""): string {
  return join(home(), currentId === DEFAULT_ID ? `${stem}${extension}` : `${stem}-${currentId}${extension}`);
}

function path(): string {
  return file("session", ".json");
}

/** Where the tab the run is on is kept between commands. */
export function tabPath(): string {
  return file("tab");
}

export function load(): State | null {
  return existsSync(path()) ? JSON.parse(readFileSync(path(), "utf8")) : null;
}

/** Every session that is open, by id. */
export function active(): [string, State][] {
  if (!existsSync(home())) return [];
  const found: [string, State][] = [];
  for (const name of readdirSync(home())) {
    const match = /^session(?:-([A-Za-z0-9_-]+))?\.json$/.exec(name);
    if (!match) continue;
    try {
      found.push([match[1] ?? DEFAULT_ID, JSON.parse(readFileSync(join(home(), name), "utf8"))]);
    } catch {
      // A file being replaced; the next listing sees it.
    }
  }
  return found;
}

/**
 * One command at a time per session: two `run`s on the same Chrome would act twice. The lock holds the pid of the
 * command, so one left by a command that died is taken over. Returns the release function.
 */
export function lock(): () => void {
  mkdirSync(home(), { recursive: true });
  const target = file("session", ".lock");
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(target, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => rmSync(target, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number.parseInt(readFileSync(target, "utf8"), 10);
      if (attempt > 0 || (Number.isInteger(holder) && holder !== process.pid && alive(holder))) {
        throw new SessionError(
          `Session ${quote(currentId)} is busy: another webhand command is using it (pid ${holder}). Wait for it, or use another --id`,
        );
      }
      rmSync(target, { force: true });
    }
  }
}

export function save(state: State): void {
  mkdirSync(home(), { recursive: true });
  const temporary = file("session", ".tmp");
  writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path());
}

export function clear(): void {
  rmSync(path(), { force: true });
  rmSync(tabPath(), { force: true });
}

/** 'new' gives null; 'profile:NAME' gives NAME. */
export function parseSession(spec: string): string | null {
  if (spec === "new") return null;
  const at = spec.indexOf(":");
  const kind = at < 0 ? spec : spec.slice(0, at);
  const name = at < 0 ? "" : spec.slice(at + 1);
  if (kind !== "profile" || !PROFILE_NAME.test(name)) {
    throw new SessionError(`Expected --session new or profile:NAME, got ${quote(spec)}`);
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
  headlessShell(): string | null {
    return shellBinary();
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

/**
 * What auto means. A run that needs no window and no saved profile uses the headless shell when one is installed:
 * half the memory, the same results (see docs/research-plan.md). A window or a profile keeps Chrome, and so does
 * asking for the Windows Chrome (--chrome windows; --chrome auto only says "use it if you can", and a headless run
 * gains nothing from it). A missing shell falls back to Chrome quietly: that is what the run used before. A named
 * engine is taken as asked. `chrome` is what --chrome asked for, not where it resolved to.
 */
export function chooseEngine(
  engine: string,
  options: { headed: boolean; profile: string | null; chrome: string },
): string {
  if (engine !== "auto") return engine;
  if (options.headed || options.profile || options.chrome === "windows") return "chrome";
  return probes.headlessShell() ? "headless-shell" : "chrome";
}

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
  return join(home(), "profiles");
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

// --- Start and stop ------------------------------------------------------------------------

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

async function reachable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** chrome-headless-shell: WEBHAND_HEADLESS_SHELL, PATH, or the newest one in Playwright's browser cache. */
function shellBinary(): string | null {
  const given = process.env.WEBHAND_HEADLESS_SHELL;
  if (given && isFile(given)) return given;
  const onPath = which("chrome-headless-shell");
  if (onPath) return onPath;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
  let builds: string[] = [];
  try {
    builds = readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-"));
  } catch {
    return null;
  }
  builds.sort((a, b) => Number.parseInt(b.split("-")[1], 10) - Number.parseInt(a.split("-")[1], 10));
  for (const build of builds) {
    const folder = join(cache, build);
    for (const inner of readdirSync(folder).filter((name) => name.startsWith("chrome-headless-shell"))) {
      const binary = join(folder, inner, "chrome-headless-shell");
      if (isFile(binary)) return binary;
    }
  }
  return null;
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

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Whether something accepts connections on this unix socket. */
async function listening(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/** daemon.ts, or daemon.js once built. */
function daemonScript(): string {
  const ts = import.meta.url.endsWith(".ts");
  return fileURLToPath(new URL(ts ? "./daemon.ts" : "./daemon.js", import.meta.url));
}

/** Where an engine's binary is: PATH, or WEBHAND_OBSCURA for Obscura (its release archive is not installed anywhere). */
function engineBinary(engine: string): string | null {
  const given = engine === "obscura" ? process.env.WEBHAND_OBSCURA : undefined;
  return given && isFile(given) ? given : which(engine);
}

/**
 * An engine (Lightpanda, Obscura) has no window and no profile, and drops its pages when a CDP connection ends. A
 * daemon runs it and holds the connection for the session; commands reach the page through state.socket (see
 * daemon.ts, remote.ts). Asks for a saved profile or a window fail here rather than being quietly dropped.
 */
async function startEngine(engine: string, options: { headed: boolean; profile: string | null }): Promise<State> {
  const name = hostName(engine, "linux");
  rejectWindowAndProfile(engine, options);
  const executable = engineBinary(engine);
  if (!executable) throw new SessionError(`${engine} was not found on PATH`);
  const port = await freePort();
  const folder = mkdtempSync(join(tmpdir(), "webhand-")); // Holds the socket; removed when the session stops.
  const socket = join(folder, "rpc.sock");
  const child = spawn(process.execPath, [daemonScript(), socket, engine, executable, String(port)], {
    detached: true, // its own process group, so it outlives this CLI call and stops as a group with the engine
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  const pid = child.pid as number;
  children.set(pid, child);
  const state: State = { pid, profile: folder, saved_profile: null, chrome: "linux", engine, headed: false, socket };
  const deadline = performance.now() + STARTUP_MS;
  while (performance.now() < deadline) {
    if (childExited(pid)) break;
    if (await listening(socket)) return state;
    await sleep(50);
  }
  await stopChrome(state);
  throw new SessionError(`${name} did not start`);
}

/** profile=null makes a new temporary folder. A saved profile is kept when the run ends. */
export async function startChrome(
  options: { headed?: boolean; profile?: string | null; chrome?: string; engine?: string } = {},
): Promise<State> {
  const headed = options.headed ?? false;
  const profile = options.profile ?? null;
  const chrome = options.chrome ?? "linux";
  if (isCloud(options.engine)) return startBrowserRun(options.engine as string, { headed, profile }, STARTUP_MS);
  if (isDaemon(options.engine)) return startEngine(options.engine as string, { headed, profile });
  const shell = options.engine === "headless-shell";
  if (shell) {
    // No window to sign in in, and a profile made by Chrome may be newer than this build.
    rejectWindowAndProfile("headless-shell", { headed, profile });
    if (chrome === "windows") throw new SessionError("The headless shell runs on Linux only");
  }
  let executable: string | null;
  if (shell) {
    executable = shellBinary();
    if (!executable) throw new SessionError("chrome-headless-shell was not found (set WEBHAND_HEADLESS_SHELL)");
  } else if (chrome === "windows") {
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

export async function stopChrome(state: State): Promise<void> {
  if (isCloud(state.engine)) return stopBrowserRun(state);
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
