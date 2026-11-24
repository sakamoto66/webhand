/** Registry of every CLI command. Each command file exports its own CommandDef. */

import type { Args, CommandSpec } from "../args.ts";
import { actCommand } from "./act.ts";
import { answerCommand } from "./answer.ts";
import { authCommand } from "./auth.ts";
import { catalogCommand } from "./catalog.ts";
import { checkCommand } from "./check.ts";
import { checkLastCommand } from "./checklast.ts";
import { doctorCommand } from "./doctor.ts";
import { extractCommand } from "./extract.ts";
import { findingsCommand } from "./findings.ts";
import { finishCommand } from "./finish.ts";
import { memoryCommand } from "./memory.ts";
import { observeCommand } from "./observe.ts";
import { profileCommand } from "./profile.ts";
import { recordCommand } from "./record.ts";
import { replanCommand } from "./replan.ts";
import { runCommand } from "./run.ts";
import { startCommand } from "./start.ts";
import type { CommandDef } from "./types.ts";

const DEFINITIONS: CommandDef[] = [
  catalogCommand,
  doctorCommand,
  startCommand,
  runCommand,
  answerCommand,
  replanCommand,
  actCommand,
  observeCommand,
  checkCommand,
  extractCommand,
  findingsCommand,
  checkLastCommand,
  finishCommand,
  recordCommand,
  authCommand,
  memoryCommand,
  profileCommand,
];

const BY_NAME = new Map<string, CommandDef>();
for (const def of DEFINITIONS) {
  BY_NAME.set(def.name, def);
  for (const alias of def.aliases ?? []) BY_NAME.set(alias, def);
}

/** Builds the CommandSpec table passed to args.parse(), expanding hidden backward-compatibility aliases. */
export function commandSpecs(): Record<string, CommandSpec> {
  const specs: Record<string, CommandSpec> = {};
  for (const def of DEFINITIONS) {
    const base = def.spec();
    specs[def.name] = { ...base, run: def.run };
    for (const alias of def.aliases ?? []) {
      specs[alias] = {
        ...base,
        help: `Alias for ${def.name} (kept for backward compatibility)`,
        hidden: true,
        run: def.run,
      };
    }
  }
  return specs;
}

/** Whether running `command` with `args` requires acquiring the session lock. */
export function needsSession(command: string, args: Args): boolean {
  const mode = BY_NAME.get(command)?.session ?? "none";
  if (mode === "required") return true;
  if (typeof mode === "function") return mode(args);
  return false;
}
