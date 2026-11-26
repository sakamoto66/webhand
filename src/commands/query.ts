/**
 * The `query` command: read-only one-shot execution (start read-only -> Jev run with 2-stage, self-verify, and
 * tactical recovery -> compact structured extraction or Jev-selected answer blocks -> automatic finish on GOAL_REPORTED
 * (blocked, not done, when no block matched the question).
 */

import * as agent from "../agent/index.ts";
import { Budget, runAgent } from "../agent/index.ts";
import { inForce } from "../agent/readonly.ts";
import type { Args } from "../args.ts";
import { Recorder } from "../core/metrics.ts";
import type { Policy } from "../core/types.ts";
import {
  build as buildExtract,
  FORMATS as EXTRACT_FORMATS,
  KINDS as EXTRACT_KINDS,
  type Format as ExtractFormat,
  type Kind as ExtractKind,
  type Raw as ExtractRaw,
  expression as extractExpression,
  format as formatExtract,
  ROWS,
  type Rows,
  WITHIN,
} from "../extract/index.ts";
import type { Driver } from "../ipc/remote.ts";
import { DEFAULT_MAX_ITEMS, formatDrilldown, textBlocks } from "../scans/drilldown.ts";
import { memoryEnabled, memoryUseEnabled, SiteMemory } from "../storage/memory.ts";
import * as session from "../storage/session.ts";
import { CliExit, deps, FAILED, OK, print } from "./context.ts";
import { runDrilldown } from "./drilldown.ts";
import { commandFinish } from "./finish.ts";
import {
  allowControlOption,
  autonomyOptions,
  chromeOption,
  engineOption,
  idOption,
  moreOption,
  valueOption,
  viewOptions,
} from "./options.ts";
import { report } from "./report.ts";
import { attach, browserView, FLOWS } from "./shared.ts";
import { startSession } from "./start.ts";
import type { CommandDef } from "./types.ts";

const DEFAULT_ATTEMPTS = 3;

async function produceCompactAnswer(
  args: Args,
  state: session.State,
  browser: Driver,
  policy: Policy,
  recorder: Recorder,
): Promise<boolean> {
  // 1. Optional list-to-detail drilldown.
  if (args.drilldown_match || args.drilldown_link_text || args.fields) {
    const fields = args.fields
      ? String(args.fields)
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
      : null;
    const result = await runDrilldown(state, browser, policy, recorder, {
      match: args.drilldown_match ?? null,
      linkText: args.drilldown_link_text ?? null,
      fields,
      maxItems: args.max_items ?? DEFAULT_MAX_ITEMS,
      more: args.more ?? null,
    });
    const style = args.format === "table" || args.format === "markdown" ? args.format : "json";
    print(formatDrilldown(result, style));
    return true;
  }

  // 2. Optional structured page extraction (table/list/link/fields/text).
  if (args.extract_kind) {
    const kind = args.extract_kind as ExtractKind;
    const within = (args.within as string | null) ?? null;
    const columns = args.columns
      ? String(args.columns)
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      : null;
    const raw = (await browser.evaluate(extractExpression(kind, within))) as ExtractRaw;
    const extraction = buildExtract(kind, raw, {
      columns,
      index: args.table ?? null,
      expectCount: null,
      within,
      rows: (args.rows ?? "raw") as Rows,
    });
    const style = (args.format ?? "json") as ExtractFormat;
    print(formatExtract(extraction, style));
    return true;
  }

  // 3. Default compact answer: parallel Jev block selection for --answer-for (or goal) instead of full page dump.
  const queryText = String(args.answer_for || state.plan.goal);
  const blocks = textBlocks(state.page);
  const snippet = String(state.page.text ?? "").slice(0, 1500);
  if (blocks.length > 1 && policy.selectBlocks) {
    const matchedKeys = await policy.selectBlocks(state.page, state.plan, queryText, blocks);
    for (const call of policy.calls) recorder.call(call);
    policy.calls.length = 0;
    const matched = blocks.filter((b) => matchedKeys.has(b.key)).map((b) => b.text);
    if (matched.length) {
      print(`QUERY ANSWER (${state.page.url}):\n${matched.join("\n---\n")}`);
      return true;
    }
    print(`QUERY NO ANSWER (${state.page.url}): no block of the page matched the question`);
    print(`The start of the page text, not an answer:\n${snippet}`);
    return false;
  }
  print(`QUERY ANSWER (${state.page.url}):\n${snippet}`);
  return true;
}

async function commandQuery(args: Args): Promise<number> {
  if (args.extract_kind && !EXTRACT_KINDS.includes(args.extract_kind as ExtractKind)) {
    throw new CliExit(`Unknown --extract-kind ${JSON.stringify(args.extract_kind)}`);
  }
  const startArgs: Args = {
    ...args,
    read_only: true,
    explore: false,
    allow_domain: [],
    max_total_actions: null,
    file: [],
    download_dir: null,
    batch: null,
    row: null,
    compare: null,
    collect: null,
    two_stage: !args.no_two_stage,
    recover: !args.no_recover,
  };
  const { state } = await startSession(startArgs);
  const policy = deps.policy();
  const browser = await attach(state, null, browserView(state));
  const recorder = new Recorder(state.log);
  let result: agent.AgentResult;
  let answered = false;
  try {
    result = await runAgent(browser, policy, state.plan, recorder, new Budget(state.max_actions, state.max_decisions), {
      history: state.history,
      readOnly: inForce(state),
      page: state.page,
      decisions: state.attempt_decisions,
      memory: state.plan.flow === "v2" && memoryEnabled() ? new SiteMemory(undefined, memoryUseEnabled()) : undefined,
      onChange: (page) => {
        state.page = page;
        session.save(state);
      },
      onDecision: (count) => {
        state.attempt_decisions = count;
        state.decisions += 1;
      },
    });
    state.page = result.page;
    state.outcome = result.outcome;
    recorder.event("escalation", {
      reason: result.outcome,
      attempt: state.plan.attempt,
      detail: result.detail,
      ...(result.jev ? { jev: result.jev } : {}),
    });
    session.save(state);

    if (result.outcome === agent.GOAL_REPORTED) {
      answered = await produceCompactAnswer(args, state, browser, policy, recorder);
    }
  } finally {
    await browser.close();
    recorder.close();
    await policy.close?.();
  }

  if (result.outcome === agent.GOAL_REPORTED) {
    if (!answered) {
      await commandFinish({ id: args.id, status: "blocked", reason: "query found no answer on the page" });
      return FAILED;
    }
    await commandFinish({ id: args.id, status: "done", reason: "read-only query completed" });
    return OK;
  }

  const code = report(state, result);
  if (args.auto_close) {
    const status = result.outcome === agent.UNCERTAIN ? "error" : "blocked";
    await commandFinish({ id: args.id, status, reason: `query stopped with ${result.outcome}` });
    return code === OK ? FAILED : code;
  }
  return code;
}

export const queryCommand: CommandDef = {
  name: "query",
  session: "required",
  spec: () => ({
    help: "Read-only one-shot query: start read-only, run Jev with autonomy, extract compact answer, and auto-finish",
    options: [
      idOption(),
      { name: "goal", type: "string" },
      { name: "url", type: "string" },
      { name: "step", type: "string", multiple: true, help: "A plan step" },
      valueOption("Text Jev may type"),
      allowControlOption(),
      { name: "service", type: "string", help: "Saved service information to give Jev" },
      { name: "runbook", type: "string", help: "A saved procedure (runbook)" },
      { name: "param", type: "string", multiple: true, metavar: "KEY=VALUE", help: "A runbook parameter" },
      { name: "allow-draft", type: "boolean", help: "Trial a draft runbook" },
      ...viewOptions(),
      moreOption(),
      ...autonomyOptions().filter((o) => o.name === "expect"),
      {
        name: "no-two-stage",
        type: "boolean",
        help: "Disable 2-stage Jev region narrowing (enabled by default in query)",
      },
      {
        name: "no-recover",
        type: "boolean",
        help: "Disable non-destructive tactical recovery (enabled by default in query)",
      },
      {
        name: "answer-for",
        type: "string",
        metavar: "QUERY",
        help: "Select only page text blocks relevant to this question instead of dumping full page text",
      },
      {
        name: "extract-kind",
        type: "string",
        choices: [...EXTRACT_KINDS],
        help: "After GOAL_REPORTED, run structured extract of this kind (table, list, link, fields, text)",
      },
      {
        name: "within",
        type: "string",
        metavar: "REGION",
        help: `With --extract-kind, restrict to: ${WITHIN.join(", ")}`,
      },
      { name: "columns", type: "string", metavar: "A,B", help: "With --extract-kind table, select these columns" },
      { name: "table", type: "int", metavar: "N", help: "With --extract-kind table, pick the Nth table" },
      { name: "rows", type: "string", default: "raw", choices: [...ROWS] },
      {
        name: "drilldown-match",
        type: "string",
        metavar: "CONDITION",
        help: "After GOAL_REPORTED, filter list rows by this condition and drill into each detail page",
      },
      {
        name: "drilldown-link-text",
        type: "string",
        metavar: "TEXT",
        help: "With drilldown, prefer detail links matching this text (e.g. Edit or View)",
      },
      {
        name: "fields",
        type: "string",
        metavar: "A,B",
        help: "With drilldown, extract only detail fields matching these labels",
      },
      { name: "max-items", type: "int", default: DEFAULT_MAX_ITEMS, metavar: "N", help: "Max detail pages to visit" },
      {
        name: "format",
        type: "string",
        default: "json",
        choices: [...EXTRACT_FORMATS],
        help: "Output format for extraction/drilldown (default: json)",
      },
      {
        name: "auto-close",
        type: "boolean",
        help: "Also close Chrome and finish as blocked/error if Jev does not reach GOAL_REPORTED",
      },
      { name: "har", type: "string", metavar: "PATH", help: "Record HTTP traffic to a HAR 1.2 file" },
      { name: "flow", type: "string", choices: [...FLOWS], default: process.env.WEBHAND_FLOW || "v2" },
      { name: "session", type: "string", default: "new" },
      { name: "auth", type: "string", metavar: "NAME" },
      chromeOption(),
      engineOption(),
      { name: "headed", type: "boolean" },
      { name: "max-attempts", type: "int", default: DEFAULT_ATTEMPTS },
      { name: "max-actions", type: "int", default: Budget.MAX_ACTIONS },
      { name: "max-decisions", type: "int", default: Budget.MAX_DECISIONS },
    ],
    conflicts: [["auth", "id"]],
  }),
  run: commandQuery,
};
