/** Shared types for `webhand check` expectation kinds. */

import type { Page } from "../core/types.ts";
import type { Element } from "../policies/base.ts";

export const KINDS = ["text", "no-text", "field", "checked", "count", "url", "title"] as const;
export type Kind = (typeof KINDS)[number];

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

export interface EvalContext {
  page: Page;
  whole: boolean;
  elements: Element[];
}

export interface ExpectationHandler {
  kind: Kind;
  parse(rest: string, raw: string): Expectation;
  evaluate(ctx: EvalContext, item: Expectation): Outcome;
}
