/** Shared helpers for expectation parsing and evaluation. */

import { ExpectationError } from "../core/errors.ts";
import { quote } from "../core/format.ts";
import type { Page } from "../core/types.ts";
import { offscreen } from "../policies/base.ts";
import type { Kind, Outcome } from "./types.ts";

export const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
export const clip = (text: string, size = 80) => (text.length > size ? `${text.slice(0, size)}…` : text);

/** Parses NAME=VALUE for expectations that compare a named subject against an expected value. */
export function parseKeyValue(kind: Kind, rest: string, raw: string): { subject: string; expected: string } {
  const eq = rest.lastIndexOf("=");
  if (eq < 0) throw new ExpectationError(`Expected ${kind}:NAME=VALUE, got ${quote(raw)}`);
  const subject = normalize(rest.slice(0, eq));
  const expected = rest.slice(eq + 1);
  if (!subject) throw new ExpectationError(`Expected ${kind}:NAME=VALUE, got ${quote(raw)}`);
  return { subject, expected };
}

/** Whether everything on the page was seen: scrolled to nothing hidden (or read whole), no cut region, no unseen frame. */
export function seenWhole(page: Page): boolean {
  const hidden = offscreen(page);
  if (!page.read && (hidden.above_px > 0 || hidden.below_px > 0)) return false;
  if (page.omitted_regions) return false;
  if (!page.read && page.regions?.some((r: Record<string, number>) => r.shown_chars < r.text_chars)) return false;
  const unseen = Object.values((page.unseen ?? {}) as Record<string, number>);
  return !unseen.some((n) => n > 0);
}

export function haystack(page: Page): string {
  return normalize([page.text, page.read?.text].filter((part) => typeof part === "string").join("\n"));
}

export function matchingLine(page: Page, needle: string): string {
  const lines = [page.text, page.read?.text].flatMap((part) => (typeof part === "string" ? part.split("\n") : []));
  const hit = lines.map(normalize).find((line) => line.includes(needle));
  return hit ?? needle;
}

export function notVisible(what: string): Outcome {
  return {
    verdict: "INCONCLUSIVE",
    reason: "not_visible",
    evidence: `${what} not seen, and part of the page was not observed; run check again with --read`,
  };
}
