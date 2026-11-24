import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Args } from "../args.ts";
import { quote } from "../core/format.ts";
import { readJsonLines } from "../core/fs.ts";
import * as workspace from "../core/workspace.ts";
import * as checkfile from "../storage/checkfile.ts";
import { OK, print } from "./context.ts";
import type { CommandDef } from "./types.ts";

interface Last {
  id: string;
  verdict: string;
  digest: string;
  at: string;
  manual: number;
}

/** The latest recorded run of each check of a saved check file, from the run logs. Reads only; judges nothing. */
export function lastRuns(name: string, runs = join(workspace.home(), "runs")): Map<string, Last> {
  const found = new Map<string, Last>();
  if (!existsSync(runs)) return found;
  for (const folder of readdirSync(runs)) {
    let files: string[];
    try {
      files = readdirSync(join(runs, folder)).filter((file) => file.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const content = readFileSync(join(runs, folder, file), "utf8");
      if (!content.includes('"check_run"')) continue;
      for (const event of readJsonLines(content)) {
        if (event.type !== "check_run" || event.check !== name) continue;
        const id = String(event.id);
        const at = String(event.at);
        if (!found.has(id) || at > (found.get(id) as Last).at) {
          found.set(id, {
            id,
            verdict: String(event.verdict),
            digest: String(event.digest),
            at,
            manual: Number(event.manual),
          });
        }
      }
    }
  }
  return found;
}

/** Prints the previous result of each check, to compare a regression run with. */
async function commandCheckLast(args: Args): Promise<number> {
  const file = checkfile.load(args.name);
  const last = lastRuns(file.name);
  print(`PREVIOUS RUNS of ${file.name} (current digest ${file.digest})`);
  for (const check of file.checks) {
    const run = last.get(check.id);
    if (!run) {
      print(`${check.id} never run`);
      continue;
    }
    const same = run.digest === file.digest ? "same check" : "THE CHECK CHANGED since then: do not compare";
    print(
      `${check.id} ${run.verdict} at ${run.at} digest ${run.digest} (${same})${run.manual ? ` manual ${run.manual} not in the verdict` : ""}`,
    );
  }
  print(`(automatic verdicts only; ${quote("MANUAL")} items are judged by Claude and not recorded here)`);
  return OK;
}

export const checkLastCommand: CommandDef = {
  name: "check-last",
  spec: () => ({
    help: "Claude: the previous result of each check of a saved check file, from the run logs (read-only)",
    options: [],
    positionals: [{ name: "name" }],
  }),
  run: commandCheckLast,
};
