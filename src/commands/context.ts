/** What every command shares: exit codes, CliExit, the test seams, and what a command prints. */

import type { Browser } from "../browser.ts";
import { JevPolicy } from "../policies/jev.ts";
import * as session from "../session.ts";
import type { Policy, Verdict } from "../types.ts";

export const OK = 0;

export const FAILED = 1;

export const STALE = 3;

export const UNCERTAIN = 4;

export const BUDGET = 5;

/** `check`: at least one expectation failed. */
export const CHECK_FAIL = 6;

/** `check`: none failed, but at least one could not be judged. */
export const CHECK_INCONCLUSIVE = 7;

/** `extract`: the data is there but incomplete (a missing column, a part of the page that cannot be read). */
export const EXTRACT_PARTIAL = 8;

/** What a command needs to stop with a message, on stderr with exit code 1. */
export class CliExit extends Error {
  override name = "CliExit";
}

/** What tests replace: Jev, and how Chrome starts. */
export const deps = {
  policy: (): Policy & { close?(): Promise<void> } => new JevPolicy(),
  startChrome: session.startChrome,
};

/**
 * What a caller outside the CLI may add. The research wrapper (research/webhand.ts) labels a run with its
 * task and verifies it at finish; the shipped CLI passes none.
 */
export interface Hooks {
  /** Recorded as the run's task and used to name its log. */
  task?: string;
  /** Checks the final page before Chrome closes. */
  verify?: (browser: Browser, state: session.State) => Promise<Verdict>;
}

export interface Context {
  out: string[];
  err: (text: string) => void;
  log: string | null;
  hooks: Hooks;
}

let context: Context = { out: [], err: () => {}, log: null, hooks: {} };

export function print(text = ""): void {
  context.out.push(`${named(text)}\n`);
}

/** Commands Claude is told to run next carry the session's --id, so a second session is not mixed up with the first. */
export function named(text: string): string {
  const id = session.id();
  if (id === session.DEFAULT_ID) return text;
  return text
    .replace(/\b(finish|run) (?=--(?:status|human-done|value)\b)/g, `$1 --id ${id} `)
    .replace(/\bwebhand (start|run|replan|finish|act|observe)\b(?! --)/g, `webhand $1 --id ${id}`);
}

/** Runs fn and returns what it printed. For tests of the output Claude reads. */
export function captured<T>(fn: () => T): { result: T; text: string } {
  const saved = context;
  context = { out: [], err: saved.err, log: null, hooks: {} };
  try {
    const result = fn();
    return { result, text: context.out.join("") };
  } finally {
    context = saved;
  }
}

/** The context of the command running now. Replaced for each call of main, and for captured(). */
export function getContext(): Context {
  return context;
}

export function setContext(next: Context): void {
  context = next;
}
