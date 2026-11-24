/**
 * Saved logins: the cookies and localStorage of a session, kept so a later new session can start signed in
 * (`start --auth NAME`). Unlike a saved profile, a login is not tied to Chrome: any engine can take it.
 *
 * A login file is the sign-in itself. It lives only in the user's state folder, readable by the owner alone, and
 * its contents are never printed.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { SessionError } from "../core/errors.ts";
import { quote } from "../core/format.ts";
import { writeFileAtomic } from "../core/fs.ts";
import { home } from "./session.ts";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface SavedLogin {
  saved_at: string;
  state: StorageState;
}

const NAME = /^[\p{L}\p{N}_-]{1,40}$/u;

/** A login name can be a file name. */
export function checkName(name: string): string {
  if (!NAME.test(name))
    throw new SessionError(`Expected a login name of letters, digits, - or _ (up to 40), got ${quote(name)}`);
  return name;
}

function folder(): string {
  return join(home(), "auth");
}

function path(name: string): string {
  return join(folder(), `${checkName(name)}.json`);
}

export function exists(name: string): boolean {
  return existsSync(path(name));
}

export function save(name: string, state: StorageState): void {
  const login: SavedLogin = { saved_at: new Date().toISOString(), state };
  writeFileAtomic(path(name), JSON.stringify(login), { mode: 0o600, dirMode: 0o700 });
}

export function load(name: string): SavedLogin {
  return JSON.parse(readFileSync(path(name), "utf8")) as SavedLogin;
}

export function names(): string[] {
  if (!existsSync(folder())) return [];
  return readdirSync(folder())
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

export function remove(name: string): boolean {
  if (!exists(name)) return false;
  rmSync(path(name), { force: true });
  return true;
}

/** What a login holds, without its values: how many cookies, and which sites. */
export function summary(login: SavedLogin): string {
  const hosts = new Set<string>();
  for (const cookie of login.state.cookies) hosts.add(cookie.domain.replace(/^\./, ""));
  for (const origin of login.state.origins) hosts.add(new URL(origin.origin).host);
  const stored = login.state.origins.reduce((sum, origin) => sum + origin.localStorage.length, 0);
  return `${login.state.cookies.length} cookies, ${stored} localStorage items; ${[...hosts].sort().join(", ") || "no sites"}`;
}
