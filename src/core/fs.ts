/** Shared filesystem, JSONL, and package metadata helpers. */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Writes text atomically via a PID-scoped temporary file and rename. */
export function writeFileAtomic(
  target: string,
  content: string,
  options: { mode?: number; dirMode?: number } = {},
): void {
  mkdirSync(dirname(target), { recursive: true, ...(options.dirMode !== undefined ? { mode: options.dirMode } : {}) });
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, content, { encoding: "utf8", ...(options.mode !== undefined ? { mode: options.mode } : {}) });
  renameSync(temp, target);
}

/** Parses non-empty JSON Lines from text, skipping malformed lines. */
export function readJsonLines<T = Record<string, unknown>>(text: string): T[] {
  const items: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line) as T);
    } catch {
      // Skip damaged or truncated lines.
    }
  }
  return items;
}

/** The package version from package.json. */
export function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
