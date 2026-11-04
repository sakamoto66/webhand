import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../research/webhand.ts";
import { CliExit, type IO, main } from "../src/cli.ts";

export const ROOT = process.cwd();

export function tmpPath(): string {
  return mkdtempSync(join(tmpdir(), "webhand-test-"));
}

type Runner = (argv: string[], io: IO) => Promise<number>;

async function capture(runner: Runner, argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runner(argv, {
    out: (text) => {
      out += text;
    },
    err: () => {},
  });
  return { code, out };
}

async function stopMessage(runner: Runner, argv: string[]): Promise<string> {
  try {
    await capture(runner, argv);
  } catch (error) {
    if (error instanceof CliExit) return error.message;
    throw error;
  }
  throw new Error(`Expected ${argv.join(" ")} to stop with a message`);
}

/** Runs the shipped CLI and returns its exit code and stdout. */
export const cli = (...argv: string[]) => capture(main, argv);

/** Runs the shipped CLI and returns the message it stopped with. */
export const cliExit = (...argv: string[]) => stopMessage(main, argv);

/** Runs the research wrapper (research/webhand.ts), which adds --task to start and verify() to finish. */
export const research = (...argv: string[]) => capture(run, argv);

/** Runs the research wrapper and returns the message it stopped with. */
export const researchExit = (...argv: string[]) => stopMessage(run, argv);

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
