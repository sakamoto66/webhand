/**
 * CLI for the Claude + Jev agent. Each call is one short process.
 *
 * Claude plans the goal, steps, and values, reviews the outcome, and replans. Jev chooses every
 * operation toward the goal and hands control back only when it cannot continue on its own.
 *
 * Each command declares its own spec and handler under commands/; this file parses argv, locks
 * the session when needed, maps domain errors to CliExit, and records handoff metrics.
 */

import { type Args, type Parsed, parse as parseArgs } from "./args.ts";
import { CliExit, getContext, type Hooks, OK, setContext } from "./commands/context.ts";
import { commandSpecs, needsSession } from "./commands/index.ts";
import { WebhandError } from "./core/errors.ts";
import { logOnce } from "./core/metrics.ts";
import * as session from "./storage/session.ts";

export interface IO {
  out: (text: string) => void;
  err: (text: string) => void;
}

const processIO: IO = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

/** Picks the session a command works on and holds its lock until the command ends. Returns the release function. */
function takeSession(command: string, args: Args): () => void {
  if (!needsSession(command, args)) {
    session.use();
    return () => {};
  }
  try {
    session.use(args.id);
    return session.lock();
  } catch (error) {
    if (error instanceof WebhandError) throw new CliExit(error.message);
    throw error;
  }
}

/** Parses argv against the registered commands. */
export function parse(argv: string[]): Parsed | { help: string } {
  return parseArgs(argv, commandSpecs());
}

/**
 * Runs one command and returns its exit code. A CliExit or UsageError is thrown after the output is written,
 * so the caller prints its message and exits with 1 or 2.
 */
export async function main(argv: string[], io: IO = processIO, hooks: Hooks = {}): Promise<number> {
  const parsed = parse(argv);
  if ("help" in parsed) {
    io.out(parsed.help);
    return OK;
  }
  setContext({ out: [], err: io.err, log: null, hooks });
  const current = getContext();
  const release = takeSession(parsed.command, parsed.args);
  // What Claude must read is a real cost of this design, so every handoff is sized and logged.
  try {
    return await parsed.run(parsed.args);
  } catch (error) {
    if (error instanceof WebhandError) throw new CliExit(error.message);
    throw error;
  } finally {
    release();
    const text = current.out.join("");
    io.out(text);
    if (current.log) logOnce(current.log, "handoff", { command: parsed.command, chars: [...text].length });
  }
}
