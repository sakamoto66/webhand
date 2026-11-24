import { realpathSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { Args } from "../args.ts";
import { writeFileAtomic } from "../core/fs.ts";
import { logOnce } from "../core/metrics.ts";
import * as workspace from "../core/workspace.ts";
import {
  build,
  expression,
  FORMATS,
  type Format,
  format,
  KINDS,
  type Kind,
  type Raw,
  ROWS,
  type Rows,
  WITHIN,
} from "../extract/index.ts";
import { CHECK_FAIL, CHECK_INCONCLUSIVE, CliExit, EXTRACT_PARTIAL, OK, print } from "./context.ts";
import { idOption } from "./options.ts";
import { attach, browserView, requireSession } from "./shared.ts";
import type { CommandDef } from "./types.ts";

function insideDir(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function resolveOutPath(rawOut: string): string {
  const target = resolve(rawOut);
  const cwd = realpathSync(process.cwd());
  if (!insideDir(cwd, target)) {
    throw new CliExit("--out must be a path under the current directory");
  }
  const parent = dirname(target);
  try {
    if (!insideDir(cwd, realpathSync(parent))) {
      throw new CliExit("--out must be a path under the current directory");
    }
  } catch (error) {
    if (error instanceof CliExit) throw error;
    // Parent folder does not exist yet; checked via lexical containment above.
  }
  if (insideDir(resolve(workspace.stateHome()), target)) {
    throw new CliExit("--out cannot write inside webhand's saved state");
  }
  if (basename(target).startsWith(".env")) {
    throw new CliExit("--out cannot overwrite an .env file");
  }
  return target;
}

/**
 * Reads the data of the page as it is now. Read-only: it never acts, scrolls or asks a model, so what it prints is
 * the page's own text, not Claude's transcription.
 */
async function commandExtract(args: Args): Promise<number> {
  const kind = args.kind as Kind;
  if (!KINDS.includes(kind)) throw new CliExit(`Unknown kind ${JSON.stringify(kind)}. Kinds: ${KINDS.join(", ")}`);
  const style = args.format as Format;
  if (!FORMATS.includes(style)) throw new CliExit(`Unknown --format. Formats: ${FORMATS.join(", ")}`);
  const within = (args.within as string | null) ?? null;
  if (within && !WITHIN.includes(within as (typeof WITHIN)[number])) {
    throw new CliExit(`Unknown --within ${JSON.stringify(within)}. Regions: ${WITHIN.join(", ")}`);
  }
  const columns = args.columns
    ? String(args.columns)
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
    : null;
  if (args.columns && !columns?.length)
    throw new CliExit("--columns needs column names, such as --columns 'Plan,Price'");
  const outPath = args.out ? resolveOutPath(String(args.out)) : null;
  const state = requireSession();
  const browser = await attach(state, null, browserView(state));
  let raw: Raw;
  try {
    raw = (await browser.evaluate(expression(kind, within))) as Raw;
  } finally {
    await browser.close();
  }
  const extraction = build(kind, raw, {
    columns,
    index: args.table ?? null,
    expectCount: args.expect_count ?? null,
    within,
    rows: (args.rows ?? "raw") as Rows,
  });
  const rendered = format(extraction, style);
  if (outPath) {
    writeFileAtomic(outPath, `${rendered}\n`);
    print(`SAVED ${outPath} (format=${style}, count=${extraction.count}, result=${extraction.result})`);
  } else {
    print(rendered);
  }
  // Counts and sources only: the values themselves, which may be personal, are not written to the log.
  logOnce(state.log, "extract", {
    kind,
    result: extraction.result,
    count: extraction.count,
    expected: extraction.expected,
    missing_columns: extraction.missingColumns,
    notes: extraction.notes.length,
    reason: extraction.reason ?? null,
  });
  if (extraction.result === "COUNT_MISMATCH") return CHECK_FAIL;
  if (extraction.result === "INCONCLUSIVE") return CHECK_INCONCLUSIVE;
  return extraction.result === "PARTIAL" ? EXTRACT_PARTIAL : OK;
}

export const extractCommand: CommandDef = {
  name: "extract",
  session: "required",
  spec: () => ({
    help: "Claude: read the data of the page as it is now (table, list, link, fields, text); read-only, the page's own text",
    options: [
      idOption(),
      { name: "within", type: "string", metavar: "REGION", help: `Only inside this region: ${WITHIN.join(", ")}` },
      {
        name: "columns",
        type: "string",
        metavar: "A,B",
        help: "Table only: these columns, by header name; a column the page lacks is reported missing",
      },
      { name: "table", type: "int", metavar: "N", help: "Table only: the Nth table of the page" },
      {
        name: "expect-count",
        type: "int",
        metavar: "N",
        help: "The number of rows or items expected; a different count is COUNT_MISMATCH",
      },
      {
        name: "rows",
        type: "string",
        default: "raw",
        choices: [...ROWS],
        help: "Table only: raw (every row as the page has it; a row spanning the whole table is marked) or data (those rows are left out and named)",
      },
      {
        name: "format",
        type: "string",
        default: "table",
        choices: [...FORMATS],
        help: "table (default), json, csv, or markdown",
      },
      {
        name: "out",
        type: "string",
        metavar: "PATH",
        help: "Write the formatted output to a file under the current directory instead of stdout",
      },
    ],
    positionals: [{ name: "kind", choices: [...KINDS] }],
  }),
  run: commandExtract,
};
