/**
 * Research CLI wrapper for running ServiceNow/webarena-verified tasks with webhand.
 * Not shipped in npm: run from the repository root as `node research/webarena.ts COMMAND ...`.
 */

import { UsageError } from "../src/args.ts";
import { type IO, main } from "../src/cli.ts";
import { CliExit } from "../src/commands/context.ts";
import { COMMANDS } from "./webarena/commands.ts";
import { WebArenaError } from "./webarena/sites.ts";

const processIO: IO = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

/** Runs one WebArena-Verified research command and returns its exit code. */
export async function run(argv: string[], io: IO = processIO): Promise<number> {
  const [command, ...args] = argv;
  try {
    const handler = command && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
    if (handler) return await handler(args, io);
    return await main(argv, io);
  } catch (error) {
    if (error instanceof WebArenaError) throw new CliExit(error.message);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let code: number;
  try {
    code = await run(process.argv.slice(2));
  } catch (error) {
    const known = error instanceof CliExit || error instanceof UsageError;
    process.stderr.write(
      `${known ? error.message : error instanceof Error ? (error.stack ?? error.message) : error}\n`,
    );
    code = error instanceof UsageError ? 2 : 1;
  }
  process.exit(code);
}
