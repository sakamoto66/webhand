/** Plain-text table formatter for `webhand extract --format table`. */

import { quote } from "../../core/format.ts";
import type { Extraction } from "../types.ts";

const clip = (text: string) => text.replace(/\|/g, "\\|");

export function formatTable(extraction: Extraction): string {
  const { records, columns } = extraction;
  const status = [
    `RESULT: ${extraction.result}`,
    ...(extraction.result === "COUNT_MISMATCH" ? [`expected ${extraction.expected} observed ${extraction.count}`] : []),
    ...(extraction.reason ? [extraction.reason] : []),
  ].join("  ");
  const lines = [
    `EXTRACT ${extraction.kind} on ${extraction.url} (${extraction.at})`,
    ...(columns.length ? [`COLUMNS: ${columns.map(clip).join(" | ")}`] : []),
    ...records.map(
      (record, at) =>
        `${at + 1} | ${columns.map((c) => clip(record.values[c] ?? "")).join(" | ")}   (${record.source})`,
    ),
    `ROWS: ${extraction.count}   MISSING_COLUMNS: ${extraction.missingColumns.length ? extraction.missingColumns.map((c) => quote(c)).join(", ") : "none"}`,
    ...extraction.notes.map((note) => `NOTE: ${note}`),
    status,
  ];
  return lines.join("\n");
}
