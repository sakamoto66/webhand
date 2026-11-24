/**
 * Jev's role: choose the next operation, target, and value toward Claude's goal, one page at a time.
 *
 * Adapted from jev-ultrafast (MIT); see THIRD_PARTY_LICENSE_jev-ultrafast.txt.
 */

import { Agent, fetch as undiciFetch } from "undici";
import { toJson } from "../core/format.ts";
import {
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
import { type Fetch, type Json, postJson, validateChoice } from "./jev-client.ts";
import { estimateTokens, FIT_TRIES, fitChoose, OVER_LIMIT, requestSize, SHRINK, TOKEN_BUDGET } from "./jev-fit.ts";
import { buildCollect, buildCompare, buildMore, buildQuestions, compareState, NO_VALUE } from "./jev-questions.ts";
import { NOT_VISIBLE } from "./prompts.ts";

export { type Fetch, validateChoice };

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
      const extra: Partial<ModelCall> = fitted.dropped ? { dropped_elements: fitted.dropped } : {};
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
