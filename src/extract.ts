/**
 * `webhand extract`: the data of the page as it is now, read by a script and printed as it is. Nothing here touches
 * a model, and nothing is clicked, typed or scrolled. Values are the page's own text (whitespace squashed); a column
 * the page does not have is reported missing, never filled in. COMPLETE only when nothing could be left out.
 */

import { readFileSync } from "node:fs";
import { quote } from "./format.ts";

export const KINDS = ["table", "list", "link", "fields", "text"] as const;
export type Kind = (typeof KINDS)[number];

export const FORMATS = ["table", "json", "csv"] as const;
export type Format = (typeof FORMATS)[number];

export const ROWS = ["raw", "data"] as const;
export type Rows = (typeof ROWS)[number];

export const WITHIN = ["main", "nav", "header", "footer", "aside", "form", "dialog", "search", "table"] as const;

const SCRIPT = readFileSync(new URL("../assets/extract.js", import.meta.url), "utf8").trim();

/** The expression the browser evaluates. */
export function expression(kind: Kind, within: string | null): string {
  return `(${SCRIPT})(${JSON.stringify({ kind, within })})`;
}

interface Item {
  kind: Kind;
  at: number;
  region: string;
  // The rest depends on the kind: table (header, rows, caption, spans), list/text (text), link, fields.
  [key: string]: unknown;
}

export interface Raw {
  url: string;
  title: string;
  ready: boolean;
  busy: number;
  within_found: boolean;
  unseen: { frames: number; canvases: number; objects: number };
  notes: string[];
  items: Item[];
}

type Result = "COMPLETE" | "PARTIAL" | "INCONCLUSIVE" | "COUNT_MISMATCH";

export interface Extraction {
  kind: Kind;
  url: string;
  at: string;
  /** Rows (table), items (the rest): the unit counted by --expect-count. */
  count: number;
  /** One record per row or item: column name (or `value`) to text. */
  records: { source: string; values: Record<string, string> }[];
  /** The columns shown, in order. */
  columns: string[];
  missingColumns: string[];
  /** What kept the extraction from being whole. */
  notes: string[];
  result: Result;
  /** Why INCONCLUSIVE: stale, none, region. */
  reason?: "stale" | "none" | "region" | "ambiguous" | "no_header";
  expected: number | null;
}

export class ExtractError extends Error {
  override name = "ExtractError";
}

const clip = (text: string) => text.replace(/\|/g, "\\|");

function tableRecords(
  items: Item[],
  columns: string[] | null,
  index: number | null,
  mode: Rows,
): {
  records: Extraction["records"];
  columns: string[];
  missing: string[];
  notes: string[];
  reason?: Extraction["reason"];
} {
  const notes: string[] = [];
  const tables = items.filter((item) => item.kind === "table" && item.shown !== false);
  const chosen = index === null ? tables : tables.filter((table) => table.at === index);
  if (!chosen.length) return { records: [], columns: [], missing: [], notes, reason: "none" };
  const records: Extraction["records"] = [];
  let shownColumns: string[] = [];
  const missing: string[] = [];
  for (const table of chosen) {
    const header = (table.header as string[] | null) ?? null;
    const spanning = ((table.spanning as boolean[] | undefined) ?? []).map(Boolean);
    const allRows = table.rows as string[][];
    const kept = allRows.map((_, i) => i).filter((i) => mode !== "data" || !spanning[i]);
    const rows = kept.map((i) => allRows[i]);
    if (mode === "data") {
      const left = allRows.filter((_, at) => spanning[at]);
      if (left.length) {
        notes.push(
          `table ${table.at}: ${left.length} row(s) that span the whole table were left out (--rows data): ${left.map((row) => quote(row[0])).join(", ")}`,
        );
      }
    }
    if (table.spans) notes.push(`table ${table.at} has merged cells: they were expanded (spanned values repeated)`);
    if ((table.hidden_rows as number) > 0)
      notes.push(`table ${table.at}: ${table.hidden_rows} row(s) the page hides were left out`);
    let names: string[];
    let indices: number[];
    if (columns) {
      if (!header) return { records: [], columns: [], missing: [], notes, reason: "no_header" };
      names = [];
      indices = [];
      for (const wanted of columns) {
        const at = header.indexOf(wanted);
        if (at < 0) {
          if (!missing.includes(wanted)) missing.push(wanted);
        } else {
          names.push(wanted);
          indices.push(at);
        }
      }
    } else {
      names = header ?? (rows[0] ?? []).map((_, at) => `col${at + 1}`);
      indices = names.map((_, at) => at);
    }
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

function otherRecords(kind: Kind, items: Item[]): { records: Extraction["records"]; columns: string[] } {
  const records = items.map((item) => {
    const values: Record<string, string> =
      kind === "link"
        ? { name: String(item.name), href: String(item.href) }
        : kind === "fields"
          ? { label: String(item.label), type: String(item.type), value: String(item.value) }
          : kind === "text"
            ? { heading: String(item.heading), text: String(item.text) }
            : { text: String(item.text) };
    return { source: `${item.region}, ${kind} ${item.at}`, values };
  });
  const columns =
    kind === "link"
      ? ["name", "href"]
      : kind === "fields"
        ? ["label", "type", "value"]
        : kind === "text"
          ? ["heading", "text"]
          : ["text"];
  return { records, columns };
}

export interface Options {
  columns: string[] | null;
  index: number | null;
  expectCount: number | null;
  within: string | null;
  /** raw: every row as the page has it (rows that span the whole table are marked); data: those rows are left out and named. */
  rows: Rows;
}

/** Builds the extraction from what the page script returned. */
export function build(kind: Kind, raw: Raw, options: Options, at = new Date().toISOString()): Extraction {
  const base = { kind, url: raw.url, at, expected: options.expectCount, notes: [] as string[] };
  const inconclusive = (reason: NonNullable<Extraction["reason"]>, note: string): Extraction => ({
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
  let records: Extraction["records"];
  let columns: string[];
  let missing: string[] = [];
  const notes: string[] = [
    ...raw.notes.filter((note) => note === "password").map(() => "password fields were not read"),
  ];
  if (kind === "table") {
    if (
      options.expectCount !== null &&
      options.index === null &&
      raw.items.filter((i) => i.kind === "table" && i.shown !== false).length > 1
    ) {
      return inconclusive("ambiguous", "the page has several tables: give --table N to count one");
    }
    const found = tableRecords(raw.items, options.columns, options.index, options.rows);
    if (found.reason === "none") return inconclusive("none", "no table found");
    if (found.reason === "no_header")
      return inconclusive("no_header", "the table has no header row, so --columns cannot name a column");
    ({ records, columns, missing } = found);
    notes.push(...found.notes);
  } else {
    if (options.columns) throw new ExtractError("--columns is for tables");
    const found = otherRecords(kind, raw.items);
    ({ records, columns } = found);
    if (!records.length) return inconclusive("none", `no ${kind} found`);
  }
  const { frames, canvases, objects } = raw.unseen;
  const unseen = frames + canvases + objects;
  if (unseen > 0) {
    notes.push(
      `${frames} frame, ${canvases} canvas and ${objects} plugin part(s) cannot be read: data inside them is missing`,
    );
  }
  const partial =
    notes.some((note) => !note.startsWith("password")) &&
    (unseen > 0 || missing.length > 0 || notes.some((n) => n.includes("hides")));
  let result: Result = missing.length || unseen > 0 || partial ? "PARTIAL" : "COMPLETE";
  if (options.expectCount !== null && records.length !== options.expectCount) result = "COUNT_MISMATCH";
  return { ...base, count: records.length, records, columns, missingColumns: missing, notes, result };
}

const csvCell = (text: string) => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

export function format(extraction: Extraction, style: Format): string {
  const { records, columns } = extraction;
  if (style === "json") {
    return JSON.stringify(
      { ...extraction, records: records.map((record) => ({ source: record.source, ...record.values })) },
      null,
      2,
    );
  }
  const status = [
    `RESULT: ${extraction.result}`,
    ...(extraction.result === "COUNT_MISMATCH" ? [`expected ${extraction.expected} observed ${extraction.count}`] : []),
    ...(extraction.reason ? [extraction.reason] : []),
  ].join("  ");
  if (style === "csv")
    return [
      columns.map(csvCell).join(","),
      ...records.map((r) => columns.map((c) => csvCell(r.values[c] ?? "")).join(",")),
    ].join("\n");
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
