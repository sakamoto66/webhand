/** CSV formatter for `webhand extract --format csv`. */

import type { Extraction } from "../types.ts";

const csvCell = (text: string) => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

export function formatCsv(extraction: Extraction): string {
  const { records, columns } = extraction;
  return [
    columns.map(csvCell).join(","),
    ...records.map((r) => columns.map((c) => csvCell(r.values[c] ?? "")).join(",")),
  ].join("\n");
}
