/** Shared command definition contract: each command file declares its own options, help, session rule, and handler. */

import type { Args, CommandSpec } from "../args.ts";

export interface CommandDef {
  name: string;
  /** Hidden backward-compatibility aliases (e.g. learn -> record, knowledge -> memory). */
  aliases?: string[];
  /** Whether this command acquires a session lock. */
  session?: "required" | ((args: Args) => boolean) | "none";
  /** Builds the CommandSpec (options, positionals, help, conflicts) lazily so env defaults are read at parse time. */
  spec: () => Omit<CommandSpec, "run">;
  run: (args: Args) => Promise<number>;
}
