/**
 * Jev's role: choose the next operation, target, and value toward Claude's goal, one page at a time.
 *
 * Adapted from jev-ultrafast (MIT); see THIRD_PARTY_LICENSE_jev-ultrafast.txt.
 */

import { Agent, fetch as undiciFetch } from "undici";
import { toJson } from "../core/format.ts";
import {
  type Action,
  type ClaimVerdict,
  Decision,
  type HistoryEntry,
  type ModelCall,
  modelCall,
  type Page,
  type Plan,
  type Policy,
  PolicyError,
  type Value,
} from "../core/types.ts";
import { MATCH, NO, type Row } from "../scans/collect.ts";
import { type Best, type Candidate, KEEP, NONE } from "../scans/compare.ts";
import { actionSpace, fileChoices, modelState, resolve, valueChoices } from "./base.ts";
import { type Fetch, type Json, postJson, validateChoice, validateNoul } from "./jev-client.ts";
import { estimateTokens, FIT_TRIES, fitChoose, OVER_LIMIT, requestSize, SHRINK, TOKEN_BUDGET } from "./jev-fit.ts";
import {
  buildBlockSelect,
  buildCollect,
  buildCompare,
  buildMore,
  buildNoulQuestions,
  buildQuestions,
  buildRecoveryQuestion,
  buildRegionQuestion,
  buildVerifyClaims,
  compareState,
  NO_VALUE,
  type RegionCandidate,
} from "./jev-questions.ts";
import {
  CLAIM_MET,
  CLAIM_NOT_MET,
  CLAIM_UNKNOWN,
  NOT_VISIBLE,
  OPERATIONS,
  RECOVERY_STRATEGIES,
  REGION_ALL,
} from "./prompts.ts";

export { type Fetch, validateChoice, validateNoul };

/** Minimum element count before 2-stage region narrowing activates (small pages go straight to 1-stage). */
const TWO_STAGE_MIN_ELEMENTS = 16;
/** If stage-2 region-narrowed choice falls below this confidence, double-check once against the full page. */
const LOW_CONFIDENCE_THRESHOLD = 0.55;
const CLAIM_VERDICTS: ClaimVerdict[] = [CLAIM_MET, CLAIM_NOT_MET, CLAIM_UNKNOWN];

/** Groups interactive actions by their snapshot region key to build Stage-1 candidates. */
function regionCandidates(page: Page): RegionCandidate[] {
  const groups = new Map<string, string[]>();
  for (const action of page.actions ?? []) {
    if (!(action.kind in OPERATIONS)) continue;
    const region = typeof action.region === "string" && action.region ? action.region : "page";
    const labels = groups.get(region) ?? [];
    const label = String(action.label ?? "").split(" → ")[0];
    if (label && labels.length < 6 && !labels.includes(label)) labels.push(label);
    groups.set(region, labels);
  }
  const counts = new Map<string, number>();
  for (const action of page.actions ?? []) {
    if (!(action.kind in OPERATIONS)) continue;
    const region = typeof action.region === "string" && action.region ? action.region : "page";
    counts.set(region, (counts.get(region) ?? 0) + 1);
  }
  return [...groups.entries()].map(([region, labels], i) => ({
    key: String(i + 1),
    region,
    summary: `${counts.get(region) ?? 0} actions (${labels.join(", ")})`,
  }));
}

/** Keeps controls (WAIT/SCROLL/TAB) plus interactive actions belonging to the chosen region (or its children). */
function filterPageToRegion(page: Page, region: string): Page {
  const actions = (page.actions ?? []).filter((action: Action) => {
    if (!(action.kind in OPERATIONS)) return true;
    const r = typeof action.region === "string" && action.region ? action.region : "page";
    return r === region || r.startsWith(`${region}/`);
  });
  return { ...page, actions };
}

export class JevPolicy implements Policy {
  name = "jev";
  calls: ModelCall[] = [];
  servedModel: string | null = null;
  readonly key: string;
  readonly model: string;
  private readonly fetchJson: Fetch;
  private readonly agent: Agent | null;
  /** Lowered for the rest of the run when Jev refuses a request over its limit. */
  private budget = TOKEN_BUDGET;

  constructor(options: { fetch?: Fetch } = {}) {
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw new PolicyError("TYPESAFE_API_KEY is not set.");
    this.key = key;
    this.model = process.env.TYPESAFE_MODEL ?? "jev-latest";
    if (options.fetch) {
      this.fetchJson = options.fetch;
      this.agent = null;
    } else {
      // HTTP/2 when the server offers it; HTTP/1.1 otherwise.
      const agent = new Agent({ allowH2: true });
      this.agent = agent;
      this.fetchJson = (url, init) => undiciFetch(url, { ...init, dispatcher: agent });
    }
  }

  config(): Record<string, unknown> {
    return { chooser: this.servedModel ?? this.model };
  }

  async close(): Promise<void> {
    await this.agent?.close();
  }

  async compare(
    page: Page,
    plan: Plan,
    criterion: string,
    best: Best | null,
    candidates: Candidate[],
  ): Promise<string> {
    const questions = buildCompare(plan, criterion, best, candidates);
    const body = { model: this.model, state: compareState(page, plan), questions };
    const result = await this.post(body, "compare");
    const keys = [...candidates.map((item) => item.key), best ? KEEP : NONE];
    return validateChoice(result?.answers?.compare ?? {}, keys).choice;
  }

  async more(page: Page, plan: Plan, control: string, candidates: Candidate[]): Promise<string> {
    const body = { model: this.model, state: modelState(page, [], plan), questions: buildMore(control, candidates) };
    const result = await this.post(body, "more");
    const keys = [...candidates.map((item) => item.key), NONE];
    return validateChoice(result?.answers?.more ?? {}, keys).choice;
  }

  async collect(page: Page, plan: Plan, criterion: string, rows: Row[]): Promise<Set<string>> {
    const body = { model: this.model, state: compareState(page, plan), questions: buildCollect(criterion, rows) };
    const answers = (await this.post(body, "collect")).answers ?? {};
    const keys = new Set<string>();
    for (const row of rows) {
      if (validateChoice(answers[`item_${row.key}`] ?? {}, [MATCH, NO]).choice === MATCH) keys.add(row.key);
    }
    return keys;
  }

  async verifyClaims(page: Page, plan: Plan, claims: string[]): Promise<Map<string, ClaimVerdict>> {
    const state = modelState(page, [], plan);
    delete state.elements; // Verification inspects URL, title, text, read layer, and regions only.
    const body = { model: this.model, state, questions: buildVerifyClaims(plan, claims) };
    const answers = (await this.post(body, "verify")).answers ?? {};
    const verdicts = new Map<string, ClaimVerdict>();
    claims.forEach((claim, i) => {
      const choice = validateChoice(answers[`claim_${i + 1}`] ?? {}, CLAIM_VERDICTS).choice as ClaimVerdict;
      verdicts.set(claim, choice);
    });
    return verdicts;
  }

  async recover(page: Page, plan: Plan, history: HistoryEntry[]): Promise<{ strategy: string; confidence: number }> {
    const state = modelState(page, history, plan);
    delete state.elements;
    const body = { model: this.model, state, questions: buildRecoveryQuestion(plan) };
    const answers = (await this.post(body, "recover")).answers ?? {};
    const parsed = validateChoice(answers.recovery ?? {}, Object.keys(RECOVERY_STRATEGIES));
    return { strategy: parsed.choice, confidence: parsed.confidence };
  }

  async selectBlocks(
    page: Page,
    plan: Plan,
    query: string,
    blocks: { key: string; text: string }[],
  ): Promise<Set<string>> {
    const body = { model: this.model, state: compareState(page, plan), questions: buildBlockSelect(query, blocks) };
    const answers = (await this.post(body, "select_blocks")).answers ?? {};
    const keys = new Set<string>();
    for (const block of blocks) {
      if (validateChoice(answers[`block_${block.key}`] ?? {}, [MATCH, NO]).choice === MATCH) keys.add(block.key);
    }
    return keys;
  }

  async scoreNoul(
    state: Record<string, unknown>,
    items: { key: string; instructions: unknown }[],
  ): Promise<Map<string, number>> {
    if (!items.length) return new Map();
    const body = { model: this.model, state, questions: buildNoulQuestions(items) };
    const answers = (await this.post(body, "noul")).answers ?? {};
    const scores = new Map<string, number>();
    for (const item of items) {
      scores.set(item.key, validateNoul(answers[item.key]));
    }
    return scores;
  }

  /** Stage-1 region selection for 2-stage Jev; returns chosen region key or null when whole page should be used. */
  private async pickRegion(page: Page, plan: Plan, history: HistoryEntry[]): Promise<string | null> {
    const candidates = regionCandidates(page);
    if (candidates.length < 2) return null;
    const state = modelState(page, history, plan);
    delete state.elements;
    const body = { model: this.model, state, questions: buildRegionQuestion(plan, candidates) };
    const answers = (await this.post(body, "region")).answers ?? {};
    const valid = [...candidates.map((c) => c.key), REGION_ALL];
    const picked = validateChoice(answers.region ?? {}, valid);
    if (picked.choice === REGION_ALL) return null;
    return candidates.find((c) => c.key === picked.choice)?.region ?? null;
  }

  private async post(body: unknown, purpose: string, extra: Partial<ModelCall> = {}): Promise<Json> {
    const started = performance.now();
    const result = await postJson(this.fetchJson, this.key, body);
    const isObject = result && typeof result === "object" && !Array.isArray(result);
    const usage = (isObject && result.usage) || {};
    this.servedModel = isObject && "model" in result ? result.model : this.model;
    this.calls.push(
      modelCall(
        "typesafe",
        this.servedModel as string,
        purpose,
        Math.round(performance.now() - started),
        "input_tokens" in usage ? usage.input_tokens : (usage.prompt_tokens ?? null),
        "output_tokens" in usage ? usage.output_tokens : (usage.completion_tokens ?? null),
      ),
    );
    Object.assign(this.calls[this.calls.length - 1], extra);
    return isObject ? result : {};
  }

  async choose(whole: Page, plan: Plan, history: HistoryEntry[]): Promise<Decision> {
    if (plan.two_stage && actionSpace(whole.actions ?? [])[0].length >= TWO_STAGE_MIN_ELEMENTS) {
      const region = await this.pickRegion(whole, plan, history);
      if (region) {
        const narrowed = filterPageToRegion(whole, region);
        const decision = await this.chooseFrom(narrowed, plan, history);
        // Read-only fallback to the full page if the chosen region missed the target or confidence is low.
        if (
          decision.operation === NOT_VISIBLE ||
          (decision.confidence !== null && decision.confidence < LOW_CONFIDENCE_THRESHOLD)
        ) {
          const full = await this.chooseFrom(whole, plan, history);
          if (decision.operation === NOT_VISIBLE) return full;
          return (full.confidence ?? 0) >= (decision.confidence ?? 0) ? full : decision;
        }
        return decision;
      }
    }
    return this.chooseFrom(whole, plan, history);
  }

  private async chooseFrom(whole: Page, plan: Plan, history: HistoryEntry[]): Promise<Decision> {
    const values = valueChoices(plan);
    const files = fileChoices(plan);
    const build = (page: Page) => {
      const [, targets, controls] = actionSpace(page.actions);
      const [questions, operations] = buildQuestions(
        plan,
        targets,
        controls,
        values,
        Boolean(page.read),
        Boolean(page.tabs),
        files,
      );
      return {
        targets,
        questions,
        operations,
        body: { model: this.model, state: modelState(page, history, plan), questions },
      };
    };
    let fitted = fitChoose(whole, build, this.budget);
    let result: Json;
    const refused: NonNullable<ModelCall["refused"]> = [];
    for (let tries = 1; ; tries++) {
      const extra: Partial<ModelCall> = fitted.dropped
        ? { dropped_elements: fitted.dropped, dropped_breakdown: fitted.breakdown }
        : {};
      if (this.budget !== TOKEN_BUDGET) extra.token_budget = this.budget;
      if (refused.length) extra.refused = refused;
      extra.request = requestSize(fitted);
      try {
        result = await this.post(fitted.body, "choose", extra);
        break;
      } catch (error) {
        const over = error instanceof PolicyError && String(error.diagnostic?.error ?? "").includes(OVER_LIMIT);
        if (!over) throw error;
        refused.push({ ...requestSize(fitted), budget: this.budget });
        if (tries >= FIT_TRIES) {
          throw new PolicyError(error.message, { ...error.diagnostic, refused });
        }
        this.budget = Math.floor(estimateTokens(toJson(fitted.body)) * SHRINK);
        fitted = fitChoose(whole, build, this.budget);
      }
    }
    const { page, targets, operations } = fitted;
    const answers = result.answers || {};
    const operationAnswer = validateChoice(answers.operation ?? {}, Object.keys(operations));
    const operation: string = operationAnswer.choice;
    const confidences: number[] = [operationAnswer.confidence];
    let target: string | null = null;
    const candidates = targets.get(operation);
    if (candidates) {
      const targetAnswer = validateChoice(answers[`${operation.toLowerCase()}_target`] ?? {}, [
        ...candidates.keys(),
        NOT_VISIBLE,
      ]);
      target = targetAnswer.choice;
      confidences.push(targetAnswer.confidence);
      if (target === NOT_VISIBLE) {
        return new Decision(NOT_VISIBLE, null, { confidence: Math.min(...confidences), wanted: operation });
      }
    }
    const decision = resolve(page, operation, target);
    if (operation === "TYPE_TEXT") {
      const valueAnswer = validateChoice(answers.type_text_value ?? {}, [...values.keys(), NO_VALUE]);
      confidences.push(valueAnswer.confidence);
      if (valueAnswer.choice !== NO_VALUE) decision.text = (values.get(valueAnswer.choice) as Value).value;
    }
    if (operation === "UPLOAD_FILE") {
      const fileAnswer = validateChoice(answers.upload_file_file ?? {}, [...files.keys(), NO_VALUE]);
      confidences.push(fileAnswer.confidence);
      if (fileAnswer.choice !== NO_VALUE) decision.text = (files.get(fileAnswer.choice) as Value).value;
    }
    decision.confidence = Math.min(...confidences);
    return decision;
  }
}
