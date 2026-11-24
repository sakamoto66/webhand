/**
 * The run state that survives between CLI calls (one JSON file per session, plus a lock), and the start and stop of
 * the session's browser, which is handed to the engine the state names (see engines/).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionError } from "../core/errors.ts";
import { quote, sleep } from "../core/format.ts";
import { writeFileAtomic } from "../core/fs.ts";
import * as workspace from "../core/workspace.ts";
import { PROFILE_NAME } from "../engines/chrome.ts";
import { engineFor } from "../engines/index.ts";
import { alive, childExited, reachable } from "../engines/process.ts";

/** How long a browser may take to start. Tests set WEBHAND_STARTUP_MS higher: several suites at once load the machine. */
const STARTUP_MS = Number(process.env.WEBHAND_STARTUP_MS) || 15_000;

export { SessionError };

// biome-ignore lint/suspicious/noExplicitAny: the session state is a JSON document shared by every command.
export type State = Record<string, any>;

export function home(): string {
  return workspace.stateHome();
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
  writeFileAtomic(path(), JSON.stringify(state), { mode: 0o600 });
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

// --- Start and stop ------------------------------------------------------------------------

/** profile=null makes a new temporary folder. A saved profile is kept when the run ends. */
export async function startChrome(
  options: { headed?: boolean; profile?: string | null; chrome?: string; engine?: string } = {},
): Promise<State> {
  return engineFor(options.engine).start({
    headed: options.headed ?? false,
    profile: options.profile ?? null,
    chrome: options.chrome ?? "linux",
    startupMs: STARTUP_MS,
  });
}

export async function stopChrome(state: State): Promise<void> {
  await engineFor(state.engine).stop(state);
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
