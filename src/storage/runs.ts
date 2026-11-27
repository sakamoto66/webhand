/**
 * Old run logs. A run folder is `runs/<stamp>[-suffix]` (or one level down, as `runs/webarena/<stamp>`). It is old when
 * both its stamp and everything in it are older than the days to keep; anything named otherwise is left alone.
 */

import { type Dirent, lstatSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/fs.ts";
import { home, stateHome } from "../core/workspace.ts";

const DEFAULT_KEEP_DAYS = 30;
const DAY_MS = 86_400_000;
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:-.*)?$/;

export function runsDir(): string {
  return join(home(), "runs");
}

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** When a folder named by stamp() was made (local time), or null for another name. */
function stamped(name: string): number | null {
  const parts = STAMP.exec(name);
  if (!parts) return null;
  const [y, month, d, h, minute, s] = parts.slice(1).map(Number);
  return new Date(y, month - 1, d, h, minute, s).getTime();
}

/** The latest change in a folder or anything under it. Links are not followed. */
function newest(path: string): number {
  const info = lstatSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  return entries(path).reduce((latest, entry) => Math.max(latest, newest(join(path, entry.name))), info.mtimeMs);
}

/** The run folders older than the days to keep, the oldest first. `keep` holds logs of sessions still open. */
export function oldRuns(days: number, keep: string[] = [], now = Date.now(), root = runsDir()): string[] {
  const cutoff = now - days * DAY_MS;
  const found: { path: string; made: number }[] = [];
  const look = (dir: string, depth: number) => {
    for (const entry of entries(dir)) {
      if (!entry.isDirectory()) continue; // A link is not a directory here, so it is never entered or removed.
      const path = join(dir, entry.name);
      const made = stamped(entry.name);
      if (made === null) {
        if (depth === 0) look(path, 1);
      } else if (made < cutoff && !keep.some((log) => log.startsWith(`${path}/`)) && newest(path) < cutoff) {
        found.push({ path, made });
      }
    }
  };
  look(root, 0);
  return found.sort((a, b) => a.made - b.made).map((run) => run.path);
}

export function removeRuns(paths: string[]): number {
  let removed = 0;
  for (const path of paths) {
    try {
      rmSync(path, { recursive: true });
      removed += 1;
    } catch {
      // Already gone, or not ours to remove: the next time tries again.
    }
  }
  return removed;
}

/** WEBHAND_RUNS_KEEP_DAYS: 30 when unset, 0 to keep everything. null when it is not a whole number of days. */
export function keepDays(): number | null {
  const text = process.env.WEBHAND_RUNS_KEEP_DAYS?.trim();
  if (!text) return DEFAULT_KEEP_DAYS;
  return /^\d+$/.test(text) ? Number(text) : null;
}

/** Removes old run folders, at most once a day. The line to print, or null. It never stops the command. */
export function autoPrune(keep: string[] = [], now = Date.now()): string | null {
  const days = keepDays();
  if (days === null) return "NOTE: WEBHAND_RUNS_KEEP_DAYS is not a whole number of days, so no old run was removed";
  if (days === 0) return null;
  try {
    const mark = join(stateHome(), "runs-pruned");
    try {
      if (now - lstatSync(mark).mtimeMs < DAY_MS) return null;
    } catch {
      // Never pruned.
    }
    writeFileAtomic(mark, "", { mode: 0o600, dirMode: 0o700 });
    utimesSync(mark, new Date(now), new Date(now));
    const removed = removeRuns(oldRuns(days, keep, now));
    if (!removed) return null;
    return `NOTE: removed ${removed} run ${removed === 1 ? "folder" : "folders"} older than ${days} days (WEBHAND_RUNS_KEEP_DAYS; 0 keeps all)`;
  } catch {
    return null;
  }
}
