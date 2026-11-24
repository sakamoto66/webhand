/** Shared input parsing and cross-option validation reused across start, run, replan, and answer. */

import { realpathSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { quote } from "../core/format.ts";
import type { Step, Value } from "../core/types.ts";
import * as workspace from "../core/workspace.ts";
import { browserUrl } from "../engines/chrome.ts";
import * as runbook from "../storage/runbook/index.ts";
import { CliExit } from "./context.ts";

const PERSON = "[person]";

export function parseValues(pairs: string[]): Value[] {
  return pairs.map((pair) => {
    const at = pair.indexOf("=");
    const label = at < 0 ? "" : pair.slice(0, at).trim();
    if (at < 0 || !label) throw new CliExit(`Expected --value LABEL=VALUE, got ${quote(pair)}`);
    return { label, value: pair.slice(at + 1) };
  });
}

/** Whether child is inside parent (or is it). Both real paths. */
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * --file LABEL=PATH: a file the run may upload. Only a file under the current directory, never the saved logins
 * or an .env, so a plan cannot send the machine's secrets to a page. The path is made absolute and real here.
 */
export function parseFiles(pairs: string[]): Value[] {
  return parseValues(pairs.map((pair) => pair.replace(/^--file=/, ""))).map(({ label, value }) => {
    let real: string;
    try {
      real = realpathSync(resolve(value));
      if (!statSync(real).isFile()) throw new Error("not a file");
    } catch {
      throw new CliExit(`--file ${quote(label)}: ${quote(value)} is not a file`);
    }
    if (!inside(realpathSync(process.cwd()), real)) {
      throw new CliExit(`--file ${quote(label)}: only files under the current directory can be uploaded`);
    }
    if (inside(resolve(workspace.stateHome()), real) || inside(realOrResolved(workspace.stateHome()), real)) {
      throw new CliExit(`--file ${quote(label)}: webhand's saved state cannot be uploaded`);
    }
    if (basename(real).startsWith(".env")) throw new CliExit(`--file ${quote(label)}: an .env file cannot be uploaded`);
    return { label, value: real };
  });
}

export function mergeValues(current: Value[], added: Value[]): Value[] {
  const merged = new Map(current.map((value) => [value.label, value]));
  for (const value of added) merged.set(value.label, value);
  return [...merged.values()];
}

/** A step written as "[person] Sign in" is one a person does in the window. */
export function parseSteps(texts: string[]): Step[] {
  return texts.map((text) => {
    const human = text.startsWith(PERSON);
    return { actor: human ? "human" : "jev", instruction: (human ? text.slice(PERSON.length) : text).trim() };
  });
}

/** A URL replan or answer may open: http, https, or file. */
function openableUrl(url: string): boolean {
  try {
    return ["http:", "https:", "file:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Resolves a CLI `--url` (http/https/file URL or local file path) to the URL the session's browser opens.
 * Returns either `{ ok: true, url }` or `{ ok: false, reason }` so callers can reject or throw as needed.
 */
export function resolveCliUrl(
  rawUrl: string,
  chrome: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  let url: string;
  try {
    url = runbook.resolveUrl(rawUrl);
  } catch (error) {
    if (!(error instanceof runbook.RunbookError)) throw error;
    return { ok: false, reason: error.message.replace("start_url", "--url") };
  }
  if (!openableUrl(url)) {
    return { ok: false, reason: "--url needs an http, https, or file URL, or a local file path" };
  }
  return { ok: true, url: browserUrl(url, chrome) };
}
