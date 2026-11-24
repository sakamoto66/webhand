/** Region view layers (focus / skip / read) shared by services, runbooks, and CLI commands. */

import { RunbookError } from "../../core/errors.ts";
import { isBlank } from "../toml.ts";

export interface View {
  focus: string[];
  skip: string[];
  read?: string[]; // Kinds of content Jev and Claude read beyond the viewport. Absent: viewport only.
}

/** Kinds the read layer can hold, by page structure. `none` clears an earlier choice. */
export const READ_KINDS = ["outline", "text", "table", "list", "link", "control", "media"];

/** Region patterns, such as "main/form:宿泊予約" or "footer". Anything else is an error. */
export function patterns(file: string, where: string, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new RunbookError(`${file}: ${where} must be a list of region keys`);
  }
  return value.map((item: string) => item.trim());
}

/**
 * Combines region choices. A later layer wins: service defaults, then the runbook, then the agent.
 * Focus patterns keep the later layer's order first, since the first focus is shown first.
 */
export function view(...layers: (Partial<View> | null | undefined)[]): View {
  let focus: string[] = [];
  let skip: string[] = [];
  let read: string[] | undefined;
  for (const layer of layers) {
    if (layer?.read?.length) read = layer.read.includes("none") ? undefined : [...layer.read]; // The later choice wins.
    if (isBlank(layer)) continue;
    const newFocus = [...(layer?.focus ?? [])];
    const newSkip = [...(layer?.skip ?? [])];
    const kept = (p: string) => !newFocus.includes(p) && !newSkip.includes(p);
    focus = [...newFocus, ...focus.filter(kept)];
    skip = [...skip.filter(kept), ...newSkip];
  }
  return read ? { focus, skip, read } : { focus, skip };
}
