/** The `knowledge` command. */

import type { Args } from "../args.ts";
import { Knowledge } from "../knowledge.ts";

import { CliExit, FAILED, OK, print } from "./context.ts";

/** What webhand learned about sites from its own runs: list, show HOST, clear [HOST]. */
export async function commandKnowledge(args: Args): Promise<number> {
  const knowledge = new Knowledge();
  if (args.action === "list") {
    const hosts = knowledge.hosts();
    if (!hosts.length) print("KNOWN SITES: (none)");
    for (const h of hosts) print(`${h.host}: ${h.pages} pages, ${h.operations} operations, ${h.worked} that worked`);
    return OK;
  }
  if (args.action === "show") {
    if (!args.name) throw new CliExit("knowledge show needs a HOST");
    const lines = knowledge.describe(args.name);
    print(lines.length ? lines.join("\n") : `Nothing is known about ${args.name}`);
    return lines.length ? OK : FAILED;
  }
  const removed = knowledge.forget(args.name ?? null);
  print(`FORGOT ${removed} ${removed === 1 ? "site" : "sites"}${args.name ? ` (${args.name})` : ""}`);
  return OK;
}
