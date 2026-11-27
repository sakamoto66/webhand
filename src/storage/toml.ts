/**
 * Shared TOML loading, scoped lookup (project wins over user), SHA-256 digest, and {param} placeholder helpers
 * used by service information, runbooks, and saved checks, all under .webhand/services/<service>/.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { isFile } from "../core/fs.ts";
import { roots, type Scope } from "../core/workspace.ts";

/**
 * One folder per service, under each scope's .webhand: services/<service>/service.toml, with its procedures in
 * runbooks/<name>.toml and its saved checks in checks/<name>.toml.
 */
export const SERVICES_DIR = "services";
export const RUNBOOKS_DIR = "runbooks";
export const CHECKS_DIR = "checks";
export const SERVICE_FILE = "service.toml";

export const WORD = "[\\p{L}\\p{N}_-]+";
export const PARAM = /\{([A-Za-z_][\p{L}\p{N}_]*)\}/gu;
export const STATUSES = new Set(["draft", "approved"]);

// biome-ignore lint/suspicious/noExplicitAny: TOML documents are untyped until validated.
export type TomlDoc = Record<string, any>;

export interface ScopedFile {
  file: string;
  scope: Scope;
  /** The folder that holds the scope's .webhand: relative local start_urls are files under it. */
  base: string;
}

/** Scope folders for a subdirectory under .webhand (e.g. "services"), project first. */
export function scopedFolders(subdir: string): { scope: Scope; dir: string }[] {
  return roots().map(({ scope, dir }) => ({ scope, dir: join(dir, subdir) }));
}

/** Finds a relative file across scopes: project wins over user. */
export function findScopedFile(subdir: string, relative: string): ScopedFile | null {
  for (const { scope, dir } of scopedFolders(subdir)) {
    const file = join(dir, relative);
    if (isFile(file)) return { file, scope, base: dirname(dirname(dir)) };
  }
  return null;
}

/** Reads and parses a UTF-8 TOML file, returning its parsed data and 16-char SHA-256 digest. */
export function readTomlFile(
  file: string,
  wrapError: (message: string) => Error,
): { raw: Buffer; data: TomlDoc; digest: string } {
  const raw = readFileSync(file);
  try {
    const data = parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as TomlDoc;
    const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    return { raw, data, digest };
  } catch (error) {
    throw wrapError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Missing, false, zero, or an empty string, list, or table. */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

export function getField(doc: TomlDoc, key: string, fallback: unknown = undefined) {
  return key in doc ? doc[key] : fallback;
}

/** Names of all {param} placeholders inside text. */
export function extractPlaceholders(text: string): string[] {
  return [...text.matchAll(PARAM)].map((match) => match[1]);
}
