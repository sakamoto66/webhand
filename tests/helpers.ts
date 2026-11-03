import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliExit, main } from "../src/cli.ts";

export const ROOT = process.cwd();

export function tmpPath(): string {
  return mkdtempSync(join(tmpdir(), "webhand-test-"));
}

/** Runs the CLI and returns its exit code and stdout. */
export async function cli(...argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await main(argv, {
    out: (text) => {
      out += text;
    },
    err: () => {},
  });
  return { code, out };
}

/** Runs the CLI and returns the message it stopped with. */
export async function cliExit(...argv: string[]): Promise<string> {
  try {
    await cli(...argv);
  } catch (error) {
    if (error instanceof CliExit) return error.message;
    throw error;
  }
  throw new Error(`Expected ${argv.join(" ")} to stop with a message`);
}

// biome-ignore lint/suspicious/noExplicitAny: log events are untyped JSON.
export function readEvents(log: string): any[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** Runs fn with the current directory changed, as a person running webhand from a project would. */
export async function inDirectory<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}
