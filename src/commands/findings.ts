import { existsSync, readFileSync } from "node:fs";
import { executed } from "../agent/index.ts";
import type { Args } from "../args.ts";
import { quote } from "../core/format.ts";
import { describeFindings, loggedFindings } from "../explore.ts";
import { CliExit, FINDINGS, OK, print } from "./context.ts";
import { idOption } from "./options.ts";
import { requireSession } from "./shared.ts";
import type { CommandDef } from "./types.ts";

/**
 * What an exploring session has noted so far, from its log, with the actions taken (the steps to repeat). Read-only:
 * it never touches the browser. A candidate is not a verdict; Claude confirms it in a new session.
 */
async function commandFindings(_args: Args): Promise<number> {
  const state = requireSession();
  if (!state.explore) throw new CliExit("This session is not exploring. Start one with: webhand start --explore");
  const found = existsSync(state.log) ? loggedFindings(readFileSync(state.log, "utf8")) : [];
  const steps = executed(state.history).map((h, i) => {
    const typed = h.kind === "fill" && h.text !== null && h.text !== undefined ? ` ${quote(String(h.text))}` : "";
    return `${i + 1}. ${h.operation} ${quote(String(h.action))}${typed}  (${h.decided_by}, ${h.url ? new URL(h.url).pathname : ""})`;
  });
  print(describeFindings(found, steps));
  return found.length ? FINDINGS : OK;
}

export const findingsCommand: CommandDef = {
  name: "findings",
  session: "required",
  spec: () => ({
    help: "Claude: the faults an exploring session noted (candidates, not verdicts) and the steps that led to them",
    options: [idOption()],
  }),
  run: commandFindings,
};
