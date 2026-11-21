import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Args } from "../args.ts";
import * as checkfile from "../checkfile.ts";
import { quote } from "../format.ts";
import * as workspace from "../workspace.ts";

import { CliExit, OK, print } from "./context.ts";

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
      for (const line of readFileSync(join(runs, folder, file), "utf8").split("\n")) {
        if (!line.includes('"check_run"')) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
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
export async function commandCheckLast(args: Args): Promise<number> {
  let file: checkfile.CheckFile;
  try {
    file = checkfile.load(args.name);
  } catch (error) {
    if (error instanceof checkfile.CheckFileError) throw new CliExit(error.message);
    throw error;
  }
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
