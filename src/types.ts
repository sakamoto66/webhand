/** Shared data shapes. Pages and actions are the plain objects produced by snapshot.js. */

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

export interface ModelCall {
  provider: string;
  model: string;
  purpose: string; // "choose"
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  /** Elements left out so the request fits Jev's limits, when any were */
  dropped_elements?: number;
  /** The lowered token budget the request was fitted to, after Jev refused one over its limit */
  token_budget?: number;
  /** What Jev counted over what was estimated for the previous request (the estimate is scaled by it) */
  token_scale?: number;
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

export class Decision {
  operation: string;
  /** null only for DONE, NEEDS_HUMAN, BLOCKED, and NOT_VISIBLE */
  action: Action | null;
  /** Lowest confidence behind this choice, when the chooser reports one */
  confidence: number | null;
  /** For TYPE_TEXT: one of Claude's values, never model-written. null: no value fits */
  text: string | null;
  /** For NOT_VISIBLE: the operation whose target was not observed */
  wanted: string | null;

  constructor(
    operation: string,
    action: Action | null = null,
    options: { confidence?: number | null; text?: string | null; wanted?: string | null } = {},
  ) {
    this.operation = operation;
    this.action = action;
    this.confidence = options.confidence ?? null;
    this.text = options.text ?? null;
    this.wanted = options.wanted ?? null;
  }
}

export interface Plan {
  goal: string;
  steps: Step[];
  values: Value[];
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

export interface Policy {
  name: string;
  /** Appended before validation, so rejected responses are still logged. */
  calls: ModelCall[];
  config(): Record<string, unknown>;
  choose(page: Page, plan: Plan, history: HistoryEntry[]): Promise<Decision>;
}
