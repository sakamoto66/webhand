/**
 * Batch execution queue for running a reviewed runbook across rows of a CSV or JSON file, one row at a time.
 *
 * Raw row values are never copied into the batch state file: only the input file path, its SHA-256 digest,
 * parameter key names, and per-row outcomes/log paths are persisted under `~/.webhand/state/batches/`.
 * At `start --batch`, the input file's digest is re-checked and the target row's values are read fresh.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { SessionError } from "../core/errors.ts";
import { quote, stamp } from "../core/format.ts";
import { isFile, writeFileAtomic } from "../core/fs.ts";
import * as runbook from "./runbook/index.ts";
import { home } from "./session.ts";

export type BatchRowStatus =
  | "pending"
  | "running"
  | "done"
  | "blocked"
  | "budget"
  | "error"
  | "abandoned"
  | "uncertain"
  | "skipped";

export interface BatchRowState {
  row: number;
  status: BatchRowStatus;
  attempts?: number;
  reason?: string | null;
  log?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface BatchState {
  id: string;
  created_at: string;
  runbook: string;
  runbook_status: string;
  runbook_digest: string;
  allow_draft: boolean;
  input_path: string;
  input_digest: string;
  param_keys: string[];
  rows: BatchRowState[];
}

export interface ResolvedBatchRow {
  state: BatchState;
  row: number;
  total: number;
  params: Record<string, string>;
}

const BATCH_NAME = /^[A-Za-z0-9_-]{1,40}$/;

/** Column/key names that look like credentials: credentials must be entered directly in Chrome by a person. */
const CREDENTIAL_KEY =
  /^(?:.*[_-])?(?:password|passwd|passcode|otp|totp|pin|cvv|cvc|card_number|credit_card|secret|api_key|access_token)$/i;

function checkBatchId(name: string): string {
  if (!BATCH_NAME.test(name)) {
    throw new SessionError(`Expected a batch name of letters, digits, - or _ (up to 40), got ${quote(name)}`);
  }
  return name;
}

function folder(): string {
  return join(home(), "batches");
}

function filePath(name: string): string {
  return join(folder(), `${checkBatchId(name)}.json`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** RFC 4180 CSV parser supporting quoted fields, embedded commas/quotes/newlines, CRLF, and UTF-8 BOM. */
export function parseCsv(text: string): { keys: string[]; rows: Record<string, string>[] } {
  const clean = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && clean[i + 1] === "\n") i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new SessionError("CSV has an unclosed quoted field");
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((cells) => cells.some((cell) => cell.trim() !== ""));
  if (nonEmpty.length < 2) {
    throw new SessionError("CSV must contain a header row and at least one data row");
  }
  const keys = nonEmpty[0].map((header) => header.trim());
  const seen = new Set<string>();
  for (const key of keys) {
    if (!key) throw new SessionError("CSV header contains an empty column name");
    if (seen.has(key)) throw new SessionError(`CSV header contains duplicate column ${quote(key)}`);
    seen.add(key);
  }

  const rows: Record<string, string>[] = [];
  for (let r = 1; r < nonEmpty.length; r++) {
    const cells = nonEmpty[r];
    if (cells.length !== keys.length) {
      throw new SessionError(`CSV row ${r}: expected ${keys.length} columns, got ${cells.length}`);
    }
    const row: Record<string, string> = {};
    for (let c = 0; c < keys.length; c++) {
      row[keys[c]] = cells[c];
    }
    rows.push(row);
  }
  return { keys, rows };
}

/** Parses a JSON array of flat key-value objects into batch rows. */
export function parseJsonRows(text: string): { keys: string[]; rows: Record<string, string>[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SessionError(`Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new SessionError("JSON input must be a non-empty array of objects");
  }
  const keySet = new Set<string>();
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SessionError(`JSON row ${i + 1}: expected an object`);
    }
    const row: Record<string, string> = {};
    for (const [rawKey, rawVal] of Object.entries(entry as Record<string, unknown>)) {
      const key = rawKey.trim();
      if (!key) throw new SessionError(`JSON row ${i + 1}: empty key name`);
      if (rawVal === null || rawVal === undefined) {
        throw new SessionError(`JSON row ${i + 1}: key ${quote(key)} is null or missing`);
      }
      if (typeof rawVal === "object") {
        throw new SessionError(`JSON row ${i + 1}: key ${quote(key)} must be a string, number, or boolean`);
      }
      keySet.add(key);
      row[key] = String(rawVal);
    }
    rows.push(row);
  }
  return { keys: [...keySet], rows };
}

function readInputFile(inputPath: string): {
  absPath: string;
  digest: string;
  keys: string[];
  rows: Record<string, string>[];
} {
  const absPath = resolve(inputPath);
  if (!isFile(absPath)) throw new SessionError(`Batch input file not found: ${inputPath}`);
  const ext = extname(absPath).toLowerCase();
  if (ext !== ".csv" && ext !== ".json") {
    throw new SessionError(`Unsupported batch input ${quote(ext || absPath)}: use .csv or .json`);
  }
  const bytes = readFileSync(absPath);
  const text = bytes.toString("utf8");
  const { keys, rows } = ext === ".csv" ? parseCsv(text) : parseJsonRows(text);
  return { absPath, digest: sha256(bytes), keys, rows };
}

function checkNoCredentialKeys(keys: string[]): void {
  const forbidden = keys.filter((key) => CREDENTIAL_KEY.test(key));
  if (forbidden.length > 0) {
    throw new SessionError(
      `Batch input must not include credential columns (${forbidden.join(", ")}). Enter credentials directly in Chrome with a [person] step.`,
    );
  }
}

function saveBatch(state: BatchState): void {
  writeFileAtomic(filePath(state.id), JSON.stringify(state, null, 2), { mode: 0o600, dirMode: 0o700 });
}

function defaultBatchId(): string {
  const base = `batch-${stamp()
    .replace(/[^0-9]/g, "")
    .slice(0, 14)}`;
  if (!existsSync(filePath(base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existsSync(filePath(candidate))) return candidate;
  }
  throw new SessionError("Could not choose a unique batch name; pass one explicitly");
}

/** Validates every row against the runbook upfront and creates a resumable batch state file. */
export function initBatch(options: { runbookName: string; inputPath: string; allowDraft?: boolean; id?: string }): {
  state: BatchState;
  startUrl: string;
} {
  const { absPath, digest, keys, rows } = readInputFile(options.inputPath);
  checkNoCredentialKeys(keys);

  const allowDraft = Boolean(options.allowDraft);
  let firstBook: runbook.Runbook | null = null;
  for (let i = 0; i < rows.length; i++) {
    try {
      const book = runbook.load(options.runbookName, rows[i]);
      if (book.status !== "approved" && !allowDraft) {
        throw new SessionError(
          `Runbook ${options.runbookName} is a draft. Trial it with --allow-draft, then get it approved`,
        );
      }
      if (!firstBook) firstBook = book;
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError(`Row ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!firstBook) throw new SessionError("Batch input has no rows");

  const id = options.id ? checkBatchId(options.id) : defaultBatchId();
  if (existsSync(filePath(id))) {
    throw new SessionError(`Batch ${quote(id)} already exists. Choose another name or clear it first`);
  }

  const state: BatchState = {
    id,
    created_at: new Date().toISOString(),
    runbook: firstBook.name,
    runbook_status: firstBook.status,
    runbook_digest: firstBook.digest,
    allow_draft: allowDraft,
    input_path: absPath,
    input_digest: digest,
    param_keys: keys,
    rows: rows.map((_, idx) => ({ row: idx + 1, status: "pending" })),
  };
  saveBatch(state);
  return { state, startUrl: firstBook.start_url };
}

export function loadBatch(id: string): BatchState {
  const path = filePath(id);
  if (!existsSync(path)) {
    const known = listBatches().map((b) => b.id);
    throw new SessionError(`Unknown batch ${quote(id)}. Saved: ${known.length ? known.join(", ") : "(none)"}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as BatchState;
}

export function listBatches(): BatchState[] {
  if (!existsSync(folder())) return [];
  const items: BatchState[] = [];
  for (const name of readdirSync(folder()).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      items.push(JSON.parse(readFileSync(join(folder(), name), "utf8")) as BatchState);
    } catch {
      // Ignore unreadable/partial files.
    }
  }
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return items;
}

export function removeBatch(id: string): boolean {
  const path = filePath(id);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** Resolves the next pending row (or an explicit --row N), verifying the input file has not changed. */
export function resolveBatchRow(id: string, requestedRow?: number): ResolvedBatchRow {
  const state = loadBatch(id);
  const { digest, rows } = readInputFile(state.input_path);
  if (digest !== state.input_digest) {
    throw new SessionError(
      `Batch ${quote(id)} input file changed since init (${state.input_path}). Create a new batch to avoid row mismatch.`,
    );
  }
  let entry: BatchRowState | undefined;
  if (requestedRow != null) {
    if (!Number.isInteger(requestedRow) || requestedRow < 1 || requestedRow > state.rows.length) {
      throw new SessionError(`Row ${requestedRow} is out of range (1..${state.rows.length})`);
    }
    entry = state.rows[requestedRow - 1];
    if (entry.status === "done") {
      throw new SessionError(`Batch ${quote(id)} row ${entry.row} is already done; refusing to run it again`);
    }
    if (entry.status === "uncertain") {
      throw new SessionError(
        `Batch ${quote(id)} row ${entry.row} ended UNCERTAIN (a change may have occurred); refusing to retry`,
      );
    }
    if (entry.status === "running") {
      throw new SessionError(`Batch ${quote(id)} row ${entry.row} is currently marked running`);
    }
  } else {
    entry = state.rows.find((row) => row.status === "pending");
    if (!entry) {
      throw new SessionError(`Batch ${quote(id)} has no pending rows left. Run: webhand batch status ${id}`);
    }
  }
  const params = rows[entry.row - 1];
  if (!params) throw new SessionError(`Row ${entry.row} missing from batch input file`);
  return { state, row: entry.row, total: state.rows.length, params };
}

export function markRowRunning(id: string, row: number): void {
  const state = loadBatch(id);
  const entry = state.rows[row - 1];
  if (!entry) return;
  entry.status = "running";
  entry.started_at = new Date().toISOString();
  saveBatch(state);
}

export function recordRowOutcome(
  id: string,
  row: number,
  outcome: { status: BatchRowStatus; reason?: string | null; attempts?: number; log?: string | null },
): { nextPending: number | null; total: number } {
  const state = loadBatch(id);
  const entry = state.rows[row - 1];
  if (entry) {
    entry.status = outcome.status;
    entry.attempts = outcome.attempts;
    entry.reason = outcome.reason ?? null;
    entry.log = outcome.log ?? null;
    entry.finished_at = new Date().toISOString();
    saveBatch(state);
  }
  const next = state.rows.find((item) => item.status === "pending")?.row ?? null;
  return { nextPending: next, total: state.rows.length };
}

export function skipRow(id: string, row: number, reason?: string): BatchRowState {
  const state = loadBatch(id);
  if (!Number.isInteger(row) || row < 1 || row > state.rows.length) {
    throw new SessionError(`Row ${row} is out of range (1..${state.rows.length})`);
  }
  const entry = state.rows[row - 1];
  if (entry.status === "done" || entry.status === "uncertain") {
    throw new SessionError(`Batch ${quote(id)} row ${row} is ${entry.status} and cannot be skipped`);
  }
  entry.status = "skipped";
  entry.reason = reason ?? "skipped by user";
  entry.finished_at = new Date().toISOString();
  saveBatch(state);
  return entry;
}

export function batchCounts(state: BatchState): Record<BatchRowStatus, number> {
  const counts: Record<BatchRowStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    blocked: 0,
    budget: 0,
    error: 0,
    abandoned: 0,
    uncertain: 0,
    skipped: 0,
  };
  for (const row of state.rows) counts[row.status] += 1;
  return counts;
}
