/**
 * `webhand extract`: the data of the page as it is now, read by a script and printed as it is. Nothing here touches
 * a model, and nothing is clicked, typed or scrolled. Values are the page's own text (whitespace squashed); a column
 * the page does not have is reported missing, never filled in. COMPLETE only when nothing could be left out.
 */

import { readFileSync } from "node:fs";
import { formatCsv } from "./formats/csv.ts";
import { formatJson } from "./formats/json.ts";
import { formatTable } from "./formats/table.ts";
import { simpleExtractor } from "./kinds/simple.ts";
import { extractTables } from "./kinds/table.ts";
import {
  type Extraction,
  type ExtractResult,
  FORMATS,
  type Format,
  type Formatter,
  type InconclusiveReason,
  KINDS,
  type Kind,
  type KindExtractor,
  type Options,
  type Raw,
  ROWS,
  type Rows,
  WITHIN,
} from "./types.ts";

export type { Extraction, Format, Kind, Options, Raw, Rows };
export { FORMATS, KINDS, ROWS, WITHIN };

const SCRIPT = readFileSync(new URL("../../assets/extract.js", import.meta.url), "utf8").trim();

/** The expression the browser evaluates. */
export function expression(kind: Kind, within: string | null): string {
  return `(${SCRIPT})(${JSON.stringify({ kind, within })})`;
}

const EXTRACTORS: Record<Kind, KindExtractor> = {
  table: extractTables,
  list: simpleExtractor("list"),
  link: simpleExtractor("link"),
  fields: simpleExtractor("fields"),
  text: simpleExtractor("text"),
};

const FORMATTERS: Record<Format, Formatter> = {
  table: formatTable,
  json: formatJson,
  csv: formatCsv,
};

/** Builds the extraction from what the page script returned. */
export function build(kind: Kind, raw: Raw, options: Options, at = new Date().toISOString()): Extraction {
  const base = { kind, url: raw.url, at, expected: options.expectCount, notes: [] as string[] };
  const inconclusive = (reason: InconclusiveReason, note: string): Extraction => ({
    ...base,
    count: 0,
    records: [],
    columns: [],
    missingColumns: [],
    notes: [note],
    result: "INCONCLUSIVE",
    reason,
  });
  if (!raw.within_found) return inconclusive("region", `no ${options.within} region on the page`);
  if (!raw.ready || raw.busy > 0) {
    return inconclusive(
      "stale",
      "the page is still loading (readyState or aria-busy): run extract again when it settles",
    );
  }
  const notes: string[] = [
    ...raw.notes.filter((note) => note === "password").map(() => "password fields were not read"),
  ];
  const found = EXTRACTORS[kind](raw, options);
  if (found.inconclusive) return inconclusive(found.inconclusive.reason, found.inconclusive.note);
  notes.push(...found.notes);
  const { frames, canvases, objects } = raw.unseen;
  const unseen = frames + canvases + objects;
  if (unseen > 0) {
    notes.push(
      `${frames} frame, ${canvases} canvas and ${objects} plugin part(s) cannot be read: data inside them is missing`,
    );
  }
  const partial =
    notes.some((note) => !note.startsWith("password")) &&
    (unseen > 0 || found.missing.length > 0 || notes.some((n) => n.includes("hides")));
  let result: ExtractResult = found.missing.length || unseen > 0 || partial ? "PARTIAL" : "COMPLETE";
  if (options.expectCount !== null && found.records.length !== options.expectCount) result = "COUNT_MISMATCH";
  return {
    ...base,
    count: found.records.length,
    records: found.records,
    columns: found.columns,
    missingColumns: found.missing,
    notes,
    result,
  };
}

export function format(extraction: Extraction, style: Format): string {
  return FORMATTERS[style](extraction);
}
