import type { Args } from "../args.ts";
import { logOnce } from "../core/metrics.ts";
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
  print(format(extraction, style));
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
        help: "table (default), json or csv",
      },
    ],
    positionals: [{ name: "kind", choices: [...KINDS] }],
  }),
  run: commandExtract,
};
