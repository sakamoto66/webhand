/**
 * Where webhand keeps what it learns and does, like Claude Code's ~/.claude and .claude:
 *
 * user     $WEBHAND_HOME, or ~/.webhand
 *   runbooks/  service information and runbooks for every project
 *   runs/      run logs, which hold page text
 *   state/     the active session and saved profiles
 * project  the nearest .webhand/ from the current directory up
 *   runbooks/  service information and runbooks for this project; they win over the user's
 *
 * Sign-ins and logs never go into a project. The Jev key comes only from the environment (TYPESAFE_API_KEY).
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Scope = "project" | "user";
const FOLDER = ".webhand";

function expandUser(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** The user's folder: $WEBHAND_HOME, or ~/.webhand. */
export function home(): string {
  return resolve(expandUser(process.env.WEBHAND_HOME || join(homedir(), FOLDER)));
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The nearest existing .webhand/ from cwd up, stopping at the home directory. null when there is none. */
export function projectRoot(cwd = process.cwd()): string | null {
  const stop = homedir();
  const user = home();
  let dir = resolve(cwd);
  while (dir !== stop) {
    const candidate = join(dir, FOLDER);
    if (candidate !== user && isDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function gitRoot(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    return out.toString().trim() || null;
  } catch {
    return null;
  }
}

/** Where a project's .webhand/ is or will be: the nearest one, else the git root's, else the cwd's. */
export function projectWriteRoot(cwd = process.cwd()): string {
  return projectRoot(cwd) ?? join(gitRoot(cwd) ?? resolve(cwd), FOLDER);
}

/** The folder for a scope, whether or not it exists yet. */
export function scopeRoot(scope: Scope): string {
  return scope === "user" ? home() : projectWriteRoot();
}

/** Existing scopes to read, project first. */
export function roots(): { scope: Scope; dir: string }[] {
  const found: { scope: Scope; dir: string }[] = [];
  const project = projectRoot();
  if (project) found.push({ scope: "project", dir: project });
  found.push({ scope: "user", dir: home() });
  return found;
}
