/** The `batch` command: initialize, inspect, skip rows, list, or clear a multi-row runbook batch. */

import type { Args } from "../args.ts";
import { SessionError } from "../core/errors.ts";
import * as batch from "../storage/batch.ts";
import { CliExit, FAILED, OK, print } from "./context.ts";
import type { CommandDef } from "./types.ts";

function formatCounts(state: batch.BatchState): string {
  const counts = batch.batchCounts(state);
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status}=${count}`);
  return parts.join(" ");
}

function printStatus(state: batch.BatchState): void {
  print(`BATCH ${state.id} runbook=${state.runbook} [${state.runbook_status}] rows=${state.rows.length}`);
  print(`INPUT: ${state.input_path} (params: ${state.param_keys.join(", ")})`);
  print(`SUMMARY: ${formatCounts(state)}`);
  print("");
  print("| Row | Status | Attempts | Reason | Log |");
  print("| --- | --- | --- | --- | --- |");
  for (const row of state.rows) {
    const attempts = row.attempts != null ? String(row.attempts) : "-";
    const reason = (row.reason ?? "-").replaceAll("|", "\\|").replaceAll("\n", " ");
    const log = row.log ?? "-";
    print(`| ${row.row} | ${row.status} | ${attempts} | ${reason} | ${log} |`);
  }
  const next = state.rows.find((r) => r.status === "pending");
  if (next) {
    print("");
    print(`NEXT: webhand start --batch ${state.id} --session new`);
  }
}

async function commandBatch(args: Args): Promise<number> {
  try {
    if (args.action === "init") {
      if (!args.runbook) throw new CliExit("batch init needs --runbook SERVICE/NAME");
      if (!args.input) throw new CliExit("batch init needs --input PATH (.csv or .json)");
      const { state, startUrl } = batch.initBatch({
        runbookName: args.runbook,
        inputPath: args.input,
        allowDraft: args.allow_draft,
        id: args.name,
      });
      if (args.json) {
        print(JSON.stringify(state, null, 2));
        return OK;
      }
      print(`BATCH CREATED ${state.id}`);
      print(`  runbook: ${state.runbook} [${state.runbook_status}]`);
      print(`  start_url: ${startUrl}`);
      print(`  input: ${state.input_path} (${state.rows.length} rows; params: ${state.param_keys.join(", ")})`);
      print(`NEXT: get user agreement, then run each row with: webhand start --batch ${state.id} --session new`);
      return OK;
    }

    if (args.action === "list") {
      const items = batch.listBatches();
      if (args.json) {
        print(JSON.stringify(items, null, 2));
        return OK;
      }
      if (!items.length) {
        print("BATCHES: (none)");
        return OK;
      }
      print("BATCHES:");
      for (const item of items) {
        print(`  ${item.id}  runbook=${item.runbook}  rows=${item.rows.length}  ${formatCounts(item)}`);
      }
      return OK;
    }

    if (args.action === "status") {
      let id: string | undefined = args.name;
      if (!id) {
        const items = batch.listBatches();
        if (!items.length) throw new CliExit("No batches found. Create one with: webhand batch init");
        id = items[0].id;
      }
      const state = batch.loadBatch(id);
      if (args.json) {
        print(JSON.stringify({ ...state, counts: batch.batchCounts(state) }, null, 2));
        return OK;
      }
      printStatus(state);
      return OK;
    }

    if (args.action === "skip") {
      if (!args.name) throw new CliExit("batch skip needs a batch NAME");
      if (args.row == null) throw new CliExit("batch skip needs --row N");
      const entry = batch.skipRow(args.name, args.row, args.reason);
      print(`SKIPPED batch=${args.name} row=${entry.row} reason=${entry.reason}`);
      return OK;
    }

    if (args.action === "clear") {
      if (!args.name) throw new CliExit("batch clear needs a batch NAME");
      if (!batch.removeBatch(args.name)) {
        print(`No batch ${args.name}`);
        return FAILED;
      }
      print(`CLEARED batch ${args.name}`);
      return OK;
    }

    throw new CliExit(`Unknown batch action: ${args.action}`);
  } catch (error) {
    if (error instanceof SessionError) throw new CliExit(error.message);
    throw error;
  }
}

export const batchCommand: CommandDef = {
  name: "batch",
  session: "none",
  spec: () => ({
    help: "Run a reviewed runbook across rows of a CSV or JSON file: init, status, list, skip, clear",
    positionals: [
      { name: "action", choices: ["init", "status", "list", "skip", "clear"] },
      { name: "name", optional: true },
    ],
    options: [
      { name: "runbook", type: "string", metavar: "SERVICE/NAME", help: "With init: runbook to execute for each row" },
      { name: "input", type: "string", metavar: "PATH", help: "With init: CSV or JSON file containing row params" },
      { name: "allow-draft", type: "boolean", help: "With init: allow a draft runbook" },
      { name: "row", type: "int", metavar: "N", help: "With skip: 1-based row number to skip" },
      { name: "reason", type: "string", help: "With skip: reason for skipping the row" },
      { name: "json", type: "boolean", default: false, help: "Print output as JSON" },
    ],
  }),
  run: commandBatch,
};
