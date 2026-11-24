/** The `memory` command (also callable via the hidden `knowledge` alias). */

import type { Args } from "../args.ts";
import { SiteMemory } from "../storage/memory.ts";
import { CliExit, FAILED, OK, print } from "./context.ts";
import type { CommandDef } from "./types.ts";

/** What webhand remembers about sites from its own runs: list, show HOST, clear [HOST]. */
async function commandMemory(args: Args): Promise<number> {
  const memory = new SiteMemory();
  if (args.action === "list") {
    const hosts = memory.hosts();
    if (!hosts.length) print("REMEMBERED SITES: (none)");
    for (const h of hosts) print(`${h.host}: ${h.pages} pages, ${h.operations} operations, ${h.worked} that worked`);
    return OK;
  }
  if (args.action === "show") {
    if (!args.name) throw new CliExit("memory show needs a HOST");
    const lines = memory.describe(args.name);
    print(lines.length ? lines.join("\n") : `Nothing is remembered about ${args.name}`);
    return lines.length ? OK : FAILED;
  }
  const removed = memory.forget(args.name ?? null);
  print(`FORGOT ${removed} ${removed === 1 ? "site" : "sites"}${args.name ? ` (${args.name})` : ""}`);
  return OK;
}

export const memoryCommand: CommandDef = {
  name: "memory",
  aliases: ["knowledge"],
  spec: () => ({
    help: "What webhand remembers about sites from its own runs: list, show HOST, clear [HOST]",
    options: [],
    positionals: [
      { name: "action", choices: ["list", "show", "clear"] },
      { name: "name", optional: true },
    ],
  }),
  run: commandMemory,
};
