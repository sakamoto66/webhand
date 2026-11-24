/** Table extraction: column selection, spanning-row filtering, and record construction. */

import { quote } from "../../core/format.ts";
import type { ExtractedKind, ExtractRecord, Options, Raw, RawItem } from "../types.ts";

function resolveColumns(
  header: string[] | null,
  rows: string[][],
  wanted: string[] | null,
  missing: string[],
): { names: string[]; indices: number[] } | null {
  if (!wanted) {
    const names = header ?? (rows[0] ?? []).map((_, at) => `col${at + 1}`);
    return { names, indices: names.map((_, at) => at) };
  }
  if (!header) return null;
  const names: string[] = [];
  const indices: number[] = [];
  for (const name of wanted) {
    const at = header.indexOf(name);
    if (at < 0) {
      if (!missing.includes(name)) missing.push(name);
    } else {
      names.push(name);
      indices.push(at);
    }
  }
  return { names, indices };
}

function collectTableNotes(table: RawItem, allRows: string[][], spanning: boolean[], mode: Options["rows"]): string[] {
  const notes: string[] = [];
  if (mode === "data") {
    const left = allRows.filter((_, at) => spanning[at]);
    if (left.length) {
      notes.push(
        `table ${table.at}: ${left.length} row(s) that span the whole table were left out (--rows data): ${left.map((row) => quote(row[0])).join(", ")}`,
      );
    }
  }
  if (table.spans) notes.push(`table ${table.at} has merged cells: they were expanded (spanned values repeated)`);
  if ((table.hidden_rows as number) > 0) {
    notes.push(`table ${table.at}: ${table.hidden_rows} row(s) the page hides were left out`);
  }
  return notes;
}

export function extractTables(raw: Raw, options: Options): ExtractedKind {
  const tables = raw.items.filter((item) => item.kind === "table" && item.shown !== false);
  if (options.expectCount !== null && options.index === null && tables.length > 1) {
    return {
      records: [],
      columns: [],
      missing: [],
      notes: [],
      inconclusive: { reason: "ambiguous", note: "the page has several tables: give --table N to count one" },
    };
  }
  const chosen = options.index === null ? tables : tables.filter((table) => table.at === options.index);
  if (!chosen.length) {
    return {
      records: [],
      columns: [],
      missing: [],
      notes: [],
      inconclusive: { reason: "none", note: "no table found" },
    };
  }
  const records: ExtractRecord[] = [];
  let shownColumns: string[] = [];
  const missing: string[] = [];
  const notes: string[] = [];

  for (const table of chosen) {
    const header = (table.header as string[] | null) ?? null;
    const spanning = ((table.spanning as boolean[] | undefined) ?? []).map(Boolean);
    const allRows = table.rows as string[][];
    const kept = allRows.map((_, i) => i).filter((i) => options.rows !== "data" || !spanning[i]);
    const rows = kept.map((i) => allRows[i]);
    notes.push(...collectTableNotes(table, allRows, spanning, options.rows));
    const resolved = resolveColumns(header, rows, options.columns, missing);
    if (!resolved) {
      return {
        records: [],
        columns: [],
        missing: [],
        notes,
        inconclusive: { reason: "no_header", note: "the table has no header row, so --columns cannot name a column" },
      };
    }
    const { names, indices } = resolved;
    if (!shownColumns.length) shownColumns = names;
    rows.forEach((row, at) => {
      const values: Record<string, string> = {};
      names.forEach((name, position) => {
        values[name] = row[indices[position]] ?? "";
      });
      const place = kept[at] + 1;
      records.push({
        source: `${table.region}, table ${table.at}, row ${place}${spanning[place - 1] ? ", spans the whole table: a note or title, not a record (--rows data leaves it out)" : ""}`,
        values,
      });
    });
  }
  return { records, columns: shownColumns, missing, notes };
}
