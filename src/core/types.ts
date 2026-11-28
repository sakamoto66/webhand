/** Shared data shapes. Pages and actions are the plain objects produced by assets/snapshot/. */

// biome-ignore lint/suspicious/noExplicitAny: pages come from the page script as untyped JSON.
export type Page = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: actions come from the page script as untyped JSON.
export type Action = Record<string, any>;

/** The model gave no usable decision. Nothing was executed. */
export class PolicyError extends Error {
  override name = "PolicyError";
  /** Why the model refused, for the run log only (such as Jev's HTTP status, request size and error body). */
  readonly diagnostic: Record<string, unknown> | null;
  constructor(message: string, diagnostic: Record<string, unknown> | null = null) {
    super(message);
    this.diagnostic = diagnostic;
  }
}

/** A decision no longer refers to the observed page. Nothing was executed. */
export class StalePage extends Error {
  override name = "StalePage";
  /** What differed from the observation, for the run log only (such as url, scroll, scope_text). */
  readonly changed: string[];
  constructor(message: string, changed: string[] = []) {
    super(message);
    this.changed = changed;
  }
}

/** A browser mutation may have happened. It must never be retried. */
export class MutationUncertain extends Error {
  override name = "MutationUncertain";
}

/** An independent check of the final page. Only research tasks supply one; it never sees the agent's DONE. */
export interface Verdict {
  success: boolean | null;
  evidence: unknown;
}

/** What was left out of a request, as element counts only: never labels or page content. */
export interface DroppedBreakdown {
  /** in_view + offscreen is the number of elements left out */
  in_view: number;
  offscreen: number;
  /** Elements left out per operation they offered; one that offered several counts under each */
  by_operation: Record<string, number>;
  /** The pass that left them out: first the per-question choice limit, then the token budget */
  by_stage: { choice_limit: number; token_budget: number };
}

export interface ModelCall {
  provider: string;
  model: string;
  purpose: string; // "choose"
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  /** Elements left out so the request fits Jev's limits, when any were */
  dropped_elements?: number;
  /** Counts of those elements, when any were left out */
  dropped_breakdown?: DroppedBreakdown;
  /** The lowered token budget the request was fitted to, after Jev refused one over its limit */
  token_budget?: number;
  /** What the request held, counts only: estimated tokens, characters, choices over all questions, and elements asked about */
  request?: { estimated_tokens: number; request_chars: number; choices: number; elements: number };
  /** The requests Jev refused over its limit before this one went through: what the refused request held */
  refused?: { estimated_tokens: number; request_chars: number; choices: number; elements: number; budget: number }[];
}

export function modelCall(
  provider: string,
  model: string,
  purpose: string,
  latency_ms: number,
  input_tokens: number | null = null,
  output_tokens: number | null = null,
): ModelCall {
  return { provider, model, purpose, latency_ms, input_tokens, output_tokens };
}

export interface AreaChunk {
  id: string;
  kind: string;
  name: string;
  breadcrumb: string;
  position: string;
  y: number;
  pinned: boolean;
  pin_reason?: string;
  text: string;
  text_chars: number;
  action_nodes: number[];
  action_count: number;
  action_preview: string[];
  parent_group?: string;
  columns?: string[];
  slice?: { index: number; total: number };
}

export class Decision {
  operation: string;
  /** null only for DONE, NEEDS_HUMAN, BLOCKED, and NOT_VISIBLE */
  action: Action | null;
  /** Lowest confidence behind this choice, when the chooser reports one */
  confidence: number | null;
  /** For TYPE_TEXT: one of Claude's values; for UPLOAD_FILE: one of Claude's file paths. Never model-written. null: none fits */
  text: string | null;
  /** For NOT_VISIBLE: the operation whose target was not observed */
  wanted: string | null;
  /** Scored context area summary (shown/total), attached only when context === "scored". */
  context_areas?: { shown: number; total: number };

  constructor(
    operation: string,
    action: Action | null = null,
    options: {
      confidence?: number | null;
      text?: string | null;
      wanted?: string | null;
      context_areas?: { shown: number; total: number };
    } = {},
  ) {
    this.operation = operation;
    this.action = action;
    this.confidence = options.confidence ?? null;
    this.text = options.text ?? null;
    this.wanted = options.wanted ?? null;
    if (options.context_areas) this.context_areas = options.context_areas;
  }
}

export interface Plan {
  goal: string;
  steps: Step[];
  values: Value[];
  /** Files Claude allows the run to upload: label and absolute path. Jev chooses a label, never a path. */
  files?: Value[];
  notes?: string[];
  /** v2: Claude's answers to Jev's questions (`webhand answer`). They continue the same attempt, so Jev sees them. */
  instructions?: string[];
  attempt?: number;
  service?: { description: string; facts: string[] } | null;
  /** v2: the page is offered whole (elements beyond the viewport with their own operations). */
  flow?: "v2" | null;
  /** Claude's criterion for choosing one item of a long list; the run compares before it acts. */
  compare?: string | null;
  /** What the comparison found in this attempt. */
  compared?: { criterion: string; best: string | null; rounds: number; stopped: string; pages?: number } | null;
  /** Claude's name for the control that shows more items (--more), pressed during a compare or collect scan. */
  more?: string | null;
  /** Claude's condition for collecting every matching item of a long list; the run collects, then stops. */
  collect?: string | null;
  /** What the collection found in this attempt. */
  collected?: {
    criterion: string;
    items: string[];
    matched: number;
    seen: number;
    rounds: number;
    stopped: string;
    pages?: number;
  } | null;
  /** Short verifiable claims checked by Jev before DONE escalates to Claude (--expect). */
  expects?: string[];
  /** Coarse-to-fine 2-stage Jev selection (region first, then elements in that region). */
  two_stage?: boolean;
  /**
   * Context selection mode: "default" (standard viewport/whole view), "scored" (2-axis noul area scoring), or
   * "visible" (the viewport's elements first, the whole page when none serves).
   */
  context?: "default" | "scored" | "visible";
  /** Allow Jev to pick a non-destructive tactical recovery strategy before stopping as STUCK. */
  recover?: boolean;
}

export interface Step {
  actor?: string;
  instruction: string;
  hints?: string[];
  done_when?: string | null;
}

export interface Value {
  label: string;
  value: string;
}

// biome-ignore lint/suspicious/noExplicitAny: history entries are logged as they are.
export type HistoryEntry = Record<string, any>;

export type ClaimVerdict = "MET" | "NOT_MET" | "UNKNOWN";

export interface Policy {
  name: string;
  /** Appended before validation, so rejected responses are still logged. */
  calls: ModelCall[];
  /** Structured policy events flushed to the run recorder alongside model calls. */
  events?: { type: string; fields: Record<string, unknown> }[];
  config(): Record<string, unknown>;
  choose(page: Page, plan: Plan, history: HistoryEntry[]): Promise<Decision>;
  /** Parallel self-verification of completion claims before DONE returns to Claude. */
  verifyClaims?(page: Page, plan: Plan, claims: string[]): Promise<Map<string, ClaimVerdict>>;
  /** Non-destructive tactical recovery choice when an attempt is about to stop as STUCK. */
  recover?(page: Page, plan: Plan, history: HistoryEntry[]): Promise<{ strategy: string; confidence: number }>;
  /** Parallel selection of text blocks relevant to a read-only query. */
  selectBlocks?(page: Page, plan: Plan, query: string, blocks: { key: string; text: string }[]): Promise<Set<string>>;
  /** Parallel noul (0..1) scoring of independent items against a shared state. */
  scoreNoul?(
    state: Record<string, unknown>,
    items: { key: string; instructions: unknown }[],
    purpose?: string,
  ): Promise<Map<string, number>>;
}
