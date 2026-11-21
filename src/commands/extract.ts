import type { Args } from "../args.ts";
import {
  build,
  ExtractError,
  expression,
  FORMATS,
  type Format,
  format,
  KINDS,
  type Kind,
  type Raw,
  WITHIN,
} from "../extract.ts";
import { logOnce } from "../metrics.ts";

import { CHECK_FAIL, CHECK_INCONCLUSIVE, CliExit, EXTRACT_PARTIAL, OK, print } from "./context.ts";
import { attach, browserView, requireSession } from "./shared.ts";

/**
 * Reads the data of the page as it is now. Read-only: it never acts, scrolls or asks a model, so what it prints is
 * the page's own text, not Claude's transcription.
 */
export async function commandExtract(args: Args): Promise<number> {
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
  let extraction: ReturnType<typeof build>;
  try {
    extraction = build(kind, raw, {
      columns,
      index: args.table ?? null,
      expectCount: args.expect_count ?? null,
      within,
    });
  } catch (error) {
    if (error instanceof ExtractError) throw new CliExit(error.message);
    throw error;
  }
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
