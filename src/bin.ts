#!/usr/bin/env node
import { UsageError } from "./args.ts";
import { main } from "./cli.ts";
import { CliExit } from "./commands/context.ts";

let code: number;
try {
  code = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliExit) {
    process.stderr.write(`${error.message}\n`);
    code = 1;
  } else if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`);
    code = 2;
  } else {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    code = 1;
  }
}
// A leftover connection must not keep the CLI alive after its output is written.
process.exit(code);
