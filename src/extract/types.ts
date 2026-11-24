/** Shared data shapes and vocabularies for `webhand extract`. */

export const KINDS = ["table", "list", "link", "fields", "text"] as const;
export type Kind = (typeof KINDS)[number];

export const FORMATS = ["table", "json", "csv", "markdown"] as const;
export type Format = (typeof FORMATS)[number];

export const ROWS = ["raw", "data"] as const;
export type Rows = (typeof ROWS)[number];

export const WITHIN = ["main", "nav", "header", "footer", "aside", "form", "dialog", "search", "table"] as const;

export interface RawItem {
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
  items: RawItem[];
}

export type ExtractResult = "COMPLETE" | "PARTIAL" | "INCONCLUSIVE" | "COUNT_MISMATCH";

export type InconclusiveReason = "stale" | "none" | "region" | "ambiguous" | "no_header";

export interface ExtractRecord {
  source: string;
  values: Record<string, string>;
}

export interface Extraction {
  kind: Kind;
  url: string;
  at: string;
  /** Rows (table), items (the rest): the unit counted by --expect-count. */
  count: number;
  /** One record per row or item: column name (or `value`) to text. */
  records: ExtractRecord[];
  /** The columns shown, in order. */
  columns: string[];
  missingColumns: string[];
  /** What kept the extraction from being whole. */
  notes: string[];
  result: ExtractResult;
  /** Why INCONCLUSIVE: stale, none, region, ambiguous, no_header. */
  reason?: InconclusiveReason;
  expected: number | null;
}

export interface Options {
  columns: string[] | null;
  index: number | null;
  expectCount: number | null;
  within: string | null;
  /** raw: every row as the page has it (rows that span the whole table are marked); data: those rows are left out and named. */
  rows: Rows;
}

export interface ExtractedKind {
  records: ExtractRecord[];
  columns: string[];
  missing: string[];
  notes: string[];
  inconclusive?: { reason: InconclusiveReason; note: string };
}

export type KindExtractor = (raw: Raw, options: Options) => ExtractedKind;
export type Formatter = (extraction: Extraction) => string;
