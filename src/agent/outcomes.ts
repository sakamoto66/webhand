/** Agent loop outcomes, budget, actor interface, and result types. */

import type { PageCheck } from "../browser/index.ts";
import type { Page } from "../core/types.ts";

// Why the loop handed control back to Claude.
export const GOAL_REPORTED = "GOAL_REPORTED"; // Jev chose DONE. Claude checks the page; finish verifies.
export const BLOCKED = "BLOCKED";
export const STUCK = "STUCK"; // Three actions in a row did not change the page, or REPEATED_CLICK.
/** The detail of a STUCK that stopped Jev from pressing again a control whose press sent a request and changed nothing. */
export const REPEATED_CLICK = "Jev chose again a click that sent a request and did not change the page; it did not run";
export const ATTEMPT_BUDGET = "ATTEMPT_BUDGET";
export const NEEDS_HUMAN = "NEEDS_HUMAN"; // A person acts in the window: sign-in, codes, CAPTCHA, [person] steps.
export const NEEDS_VALUE = "NEEDS_VALUE"; // A field needs text and none of Claude's values fits.
export const ESCALATE = "ESCALATE"; // v2: Jev handed the decision to Claude. `answer` continues the same attempt.
export const JEV_FAILED = "JEV_FAILED"; // No usable decision. Nothing was executed.
export const UNCERTAIN = "UNCERTAIN"; // A mutation may have happened. Never retried, never replanned.
export const READ_ONLY = "READ_ONLY"; // A read-only session refused the action Jev chose. Nothing was executed.

/** Outcomes after which the log keeps a page check, to tell a bot check or an error page from a plan problem. */
export const CHECKED_OUTCOMES = [BLOCKED, STUCK, ATTEMPT_BUDGET, NEEDS_HUMAN];

export const MISSING = "missing"; // A history entry for a NOT_VISIBLE choice: nothing ran, but Jev must see it.
export const STALE = "stale"; // A history entry for a choice the browser refused as stale: nothing ran.

/** Per attempt. A replan starts a new attempt with a fresh budget. */
export class Budget {
  static readonly MAX_ACTIONS = 30;
  static readonly MAX_DECISIONS = 60;
  maxActions: number;
  maxDecisions: number;

  constructor(maxActions = Budget.MAX_ACTIONS, maxDecisions = Budget.MAX_DECISIONS) {
    this.maxActions = maxActions;
    this.maxDecisions = maxDecisions;
  }
}

/** What the loop needs from a browser. */
export interface Actor {
  observe(): Promise<Page>;
  fresh(page: Page, action?: Page | null): Promise<boolean>;
  act(action: Page, page: Page, text?: string | null): Promise<void>;
  screenshot?(): Promise<Buffer>;
  check?(): Promise<PageCheck>;
  /** Parts of the page webhand cannot see into, counted for the run log. */
  unseen?(): Promise<Record<string, number>>;
  /** New windows the page asked for since the last call. A browser that cannot open one lists them, so the log shows it. */
  ignoredWindows?(): Promise<string[]>;
  /** Whether the last act sent a request that is not a read, as a form or a save does. */
  sentRequest?(): Promise<boolean>;
  /** Files the last act downloaded, once. Only a local Chrome with a download directory has any. */
  takeDownloads?(): { name: string; bytes: number }[];
}

export interface AgentResult {
  outcome: string;
  detail: string | null;
  page: Page;
  actions: number;
  decisions: number;
  elapsed_ms: number;
  field?: Record<string, unknown>;
  /** Why Jev refused (JEV_FAILED), for the run log only. */
  jev?: Record<string, unknown>;
}
