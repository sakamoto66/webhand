/**
 * `webhand check`: a read-only comparison of Claude's expectations with one observation of the page. Nothing here
 * touches the browser or a model. A negative result (not found, a different count) needs the whole page to have
 * been seen; otherwise it is INCONCLUSIVE, never FAIL, so a missed look is not read as a product defect.
 */

import { quote } from "./format.ts";
import { actionSpace, offscreen } from "./policies/base.ts";
import type { Page } from "./types.ts";

const KINDS = ["text", "no-text", "field", "checked", "count", "url", "title"] as const;
type Kind = (typeof KINDS)[number];

export interface Expectation {
  kind: Kind;
  /** The text, label, role, path or title. */
  subject: string;
  /** The expected value, for field, checked and count. */
  expected: string | null;
  raw: string;
}

type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface Outcome {
  verdict: Verdict;
  /** INCONCLUSIVE only: not_visible, not_found, ambiguous. */
  reason?: "not_visible" | "not_found" | "ambiguous";
  /** What was observed, quoted. */
  evidence: string;
}

export class ExpectationError extends Error {
  override name = "ExpectationError";
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, size = 80) => (text.length > size ? `${text.slice(0, size)}…` : text);

/** KIND:SUBJECT, or KIND:SUBJECT=VALUE for field, checked and count. */
export function parseExpectation(raw: string): Expectation {
  const at = raw.indexOf(":");
  const kind = (at < 0 ? raw : raw.slice(0, at)) as Kind;
  if (!KINDS.includes(kind))
    throw new ExpectationError(`Unknown expectation ${quote(raw)}. Kinds: ${KINDS.join(", ")}`);
  const rest = at < 0 ? "" : raw.slice(at + 1);
  if (!normalize(rest)) throw new ExpectationError(`Expectation ${quote(raw)} has nothing to check`);
  if (kind === "field" || kind === "checked" || kind === "count") {
    const eq = rest.lastIndexOf("=");
    if (eq < 0) throw new ExpectationError(`Expected ${kind}:NAME=VALUE, got ${quote(raw)}`);
    const subject = normalize(rest.slice(0, eq));
    const expected = rest.slice(eq + 1);
    if (!subject) throw new ExpectationError(`Expected ${kind}:NAME=VALUE, got ${quote(raw)}`);
    if (kind === "checked" && expected !== "true" && expected !== "false") {
      throw new ExpectationError(`checked takes true or false, got ${quote(raw)}`);
    }
    if (kind === "count" && !/^\d+$/.test(expected)) {
      throw new ExpectationError(`count takes a whole number, got ${quote(raw)}`);
    }
    return { kind, subject, expected, raw };
  }
  return { kind, subject: kind === "url" || kind === "title" ? rest : normalize(rest), expected: null, raw };
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

function haystack(page: Page): string {
  return normalize([page.text, page.read?.text].filter((part) => typeof part === "string").join("\n"));
}

function matchingLine(page: Page, needle: string): string {
  const lines = [page.text, page.read?.text].flatMap((part) => (typeof part === "string" ? part.split("\n") : []));
  const hit = lines.map(normalize).find((line) => line.includes(needle));
  return hit ?? needle;
}

const notVisible = (what: string): Outcome => ({
  verdict: "INCONCLUSIVE",
  reason: "not_visible",
  evidence: `${what} not seen, and part of the page was not observed; use replan --read or --whole`,
});

export function evaluate(page: Page, item: Expectation): Outcome {
  const whole = seenWhole(page);
  const [elements] = actionSpace(page.actions ?? []);
  switch (item.kind) {
    case "text": {
      if (haystack(page).includes(item.subject)) {
        return { verdict: "PASS", evidence: quote(clip(matchingLine(page, item.subject))) };
      }
      return whole ? { verdict: "FAIL", evidence: "not on the page" } : notVisible(quote(item.subject));
    }
    case "no-text": {
      if (haystack(page).includes(item.subject)) {
        return { verdict: "FAIL", evidence: `found: ${quote(clip(matchingLine(page, item.subject)))}` };
      }
      return whole ? { verdict: "PASS", evidence: "not on the page" } : notVisible(quote(item.subject));
    }
    case "field":
    case "checked": {
      const key = item.kind === "field" ? "value" : "checked";
      const found = elements.filter((element) => normalize(String(element.label)) === item.subject && key in element);
      if (found.length === 0) {
        return { verdict: "INCONCLUSIVE", reason: "not_found", evidence: `no observed field ${quote(item.subject)}` };
      }
      if (found.length > 1) {
        const where = found.map((element) => `[${element.index}] ${quote(element[key])}`).join(", ");
        return { verdict: "INCONCLUSIVE", reason: "ambiguous", evidence: `${found.length} fields: ${where}` };
      }
      const [element] = found;
      const observed = item.kind === "field" ? String(element.value) : String(element.checked);
      const same = observed === item.expected;
      return {
        verdict: same ? "PASS" : "FAIL",
        evidence: `${same ? "" : `expected ${quote(item.expected)} `}observed ${quote(observed)} (${element.role} [${element.index}])`,
      };
    }
    case "count": {
      const count = elements.filter((element) => element.role === item.subject).length;
      if (!whole) return notVisible(`all ${quote(item.subject)} elements`);
      const same = String(count) === item.expected;
      return {
        verdict: same ? "PASS" : "FAIL",
        evidence: `${same ? "" : `expected ${item.expected} `}observed ${count}`,
      };
    }
    case "url": {
      const target = item.subject.startsWith("/") ? pathOf(String(page.url)) : String(page.url);
      const same = target === item.subject;
      return {
        verdict: same ? "PASS" : "FAIL",
        evidence: `${same ? "" : `expected ${quote(item.subject)} `}observed ${quote(target)}`,
      };
    }
    case "title": {
      const same = String(page.title) === item.subject;
      return {
        verdict: same ? "PASS" : "FAIL",
        evidence: `${same ? "" : `expected ${quote(item.subject)} `}observed ${quote(String(page.title))}`,
      };
    }
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
