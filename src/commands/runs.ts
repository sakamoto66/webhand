/** The `runs` command: old run logs. */

import type { Args } from "../args.ts";
import { keepDays, oldRuns, removeRuns, runsDir } from "../storage/runs.ts";
import * as session from "../storage/session.ts";
import { CliExit, OK, print } from "./context.ts";
import type { CommandDef } from "./types.ts";

/** Logs the open sessions are writing. */
export function openLogs(): string[] {
  return session.active().map(([, state]) => String(state.log));
}

/** Lists the run folders older than the days given; `prune --yes` removes them. */
async function commandRuns(args: Args): Promise<number> {
  const days: number | null = args.older_than ?? keepDays();
  if (days === null || days < 1) {
    throw new CliExit("Give --older-than DAYS (1 or more), or set WEBHAND_RUNS_KEEP_DAYS to such a number");
  }
  const old = oldRuns(days, openLogs());
  print(`RUNS ${runsDir()}: ${old.length} older than ${days} days`);
  for (const path of old) print(`  ${path}`);
  if (args.action === "prune" && old.length) {
    if (args.yes) print(`REMOVED ${removeRuns(old)}`);
    else print("Nothing was removed. Run again with --yes to remove these.");
  }
  return OK;
}

export const runsCommand: CommandDef = {
  name: "runs",
  spec: () => ({
    help: "Old run logs: list, or prune them",
    options: [
      { name: "older-than", type: "int", metavar: "DAYS", help: "Default: WEBHAND_RUNS_KEEP_DAYS, or 30" },
      { name: "yes", type: "boolean", help: "With prune, remove what is listed" },
    ],
    positionals: [{ name: "action", choices: ["list", "prune"] }],
  }),
  run: commandRuns,
};
