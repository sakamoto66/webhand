/**
 * Where webhand keeps what it learns and does, like Claude Code's ~/.claude and .claude:
 *
 * user     $WEBHAND_HOME, or ~/.webhand
 *   runbooks/  service information and runbooks for every project
 *   runs/      run logs, which hold page text
 *   state/     the active session and saved profiles
 *   .env       TYPESAFE_API_KEY and TYPESAFE_MODEL
 * project  the nearest .webhand/ from the current directory up
 *   runbooks/  service information and runbooks for this project; they win over the user's
 *
 * Sign-ins, logs, and keys never go into a project.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Scope = "project" | "user";
export const SCOPES: Scope[] = ["project", "user"];
export const FOLDER = ".webhand";

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

/** Reads home()/.env. Variables already set win. */
export function loadEnv(): void {
  const file = join(home(), ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    let text = line.trim();
    if (text.startsWith("export ")) text = text.slice("export ".length);
    const at = text.indexOf("=");
    if (at < 0) continue;
    const key = text.slice(0, at).trim();
    const value = text
      .slice(at + 1)
      .trim()
      .replace(/^['"]+|['"]+$/g, "");
    if (key && !key.startsWith("#") && !(key in process.env)) process.env[key] = value;
  }
}
