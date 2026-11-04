/**
 * What Claude and Jev read is part of the experiment. tests/golden/cases.json holds the reference
 * output, compared character for character. A change to it is an experimental variable:
 * regenerate with `npm run test:golden:update` and record why in the commit message.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test, vi } from "vitest";
import type { AgentResult } from "../src/agent.ts";
import { captured, describePlan, recentActions, render, report } from "../src/cli.ts";
import { toJson } from "../src/format.ts";
import { actionSpace, modelState, valueChoices } from "../src/policies/base.ts";
import { buildQuestions, JevPolicy } from "../src/policies/jev.ts";
import * as runbook from "../src/runbook.ts";
import { type Page, type Plan, PolicyError } from "../src/types.ts";
import { ROOT } from "./helpers.ts";

const GOLDEN = join(ROOT, "tests", "golden");
const pages: Record<string, Page> = JSON.parse(readFileSync(join(GOLDEN, "pages.json"), "utf8"));
// biome-ignore lint/suspicious/noExplicitAny: recorded outputs.
const cases: Record<string, any> = JSON.parse(readFileSync(join(GOLDEN, "cases.json"), "utf8"));

const UPDATE = Boolean(process.env.UPDATE_GOLDEN);
// biome-ignore lint/suspicious/noExplicitAny: recorded outputs.
const recorded: Record<string, any> = { report: {} };

/** Compares with the reference, or records the actual value when regenerating. */
function golden(actual: unknown, ...path: string[]) {
  const key = path.at(-1) as string;
  // biome-ignore lint/suspicious/noExplicitAny: recorded outputs.
  let expected: any = cases;
  // biome-ignore lint/suspicious/noExplicitAny: recorded outputs.
  let record: any = recorded;
  for (const part of path.slice(0, -1)) {
    expected = expected?.[part];
    record[part] ??= {};
    record = record[part];
  }
  record[key] = actual;
  if (!UPDATE) expect(actual).toEqual(expected?.[key]);
}

afterAll(() => {
  if (UPDATE) writeFileSync(join(GOLDEN, "cases.json"), `${JSON.stringify(recorded, null, 2)}\n`);
});

const plan: Plan = {
  goal: "Find a stay",
  steps: [
    { actor: "jev", instruction: "Search", hints: ["Press Find"], done_when: "Results shown" },
    { actor: "human", instruction: "Sign in" },
  ],
  values: [
    { label: "Destination", value: "Lisbon" },
    { label: "Name's", value: "O'Neil" },
  ],
  notes: ["Attempt 1 ended with STUCK. Claude: x"],
  attempt: 2,
  service: { description: "A demo", facts: ["Fact one"] },
};
const history = [
  {
    step: 1,
    attempt: 2,
    decided_by: "jev",
    operation: "TYPE_TEXT",
    kind: "fill",
    action: "Destination",
    text: "Lisbon",
    url: "u",
    page_changed: true,
    confidence: 0.5,
  },
  {
    step: 2,
    attempt: 2,
    kind: "human",
    operation: "HUMAN",
    action: "A person did it",
    text: null,
    url: "u",
    page_changed: true,
  },
  {
    step: 3,
    attempt: 2,
    operation: "STALE",
    kind: "stale",
    action: "CLICK 'Go' did not run: x",
    text: null,
    url: "u",
    page_changed: false,
  },
  { step: 4, attempt: 1, kind: "click", operation: "CLICK", action: "Old", text: null, url: "u", page_changed: false },
];

test.each(Object.keys(pages))("page %s renders, states, and asks as recorded", (name) => {
  const page = pages[name];
  const [, targets, controls] = actionSpace(page.actions);
  const [questions, operations] = buildQuestions(plan, targets, controls, valueChoices(plan));
  golden(render(page), name, "render");
  golden(toJson(modelState(page, history, plan)), name, "model_state");
  golden(toJson(modelState(page, [])), name, "model_state_noplan");
  golden(toJson(questions), name, "questions");
  golden(toJson(operations), name, "operations");
});

test.each(Object.keys(pages))("the request to Jev for page %s is byte for byte as recorded", async (name) => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  vi.stubEnv("TYPESAFE_MODEL", undefined);
  let body = "";
  const policy = new JevPolicy({
    fetch: async (_url, init) => {
      body = init.body;
      return { status: 200, json: async () => ({}) };
    },
  });
  await expect(policy.choose(pages[name], plan, history)).rejects.toThrow(PolicyError);
  golden(body, name, "body");
});

test("plans and recent actions print as recorded", () => {
  const state = { plan, history, max_attempts: 3, page: pages.tricky };
  golden(describePlan(plan, { focus: ["form", "x"], skip: [] }), "describe_plan");
  golden(describePlan({ goal: "g", steps: [], values: [] }, null), "describe_plan_goal_only");
  golden(recentActions(state), "recent_actions");
  golden(recentActions({ ...state, history: [] }), "recent_actions_empty");
});

test.each(Object.keys(cases.report))("the %s report prints as recorded", (outcome) => {
  const state = { plan, history, max_attempts: 3, page: pages.tricky };
  const result = {
    outcome,
    detail: "detail 'x'",
    field: { label: "Name's", role: "textbox", value: null },
  } as unknown as AgentResult;
  const { result: code, text } = captured(() => report(state, result));
  golden({ code, text }, "report", outcome);
});

test("the repository's runbooks load and list as recorded", () => {
  const loaded = runbook.load("hotel/filter", { city: "Lisbon", category: "Design", stay: "Casa Flora" });
  loaded.start_url = loaded.start_url.replace(pathToFileURL(ROOT).href, "ROOT");
  golden(JSON.parse(JSON.stringify(loaded)), "runbook_load");
  const hotel = runbook.catalog().filter((entry) => entry.service.startsWith("hotel"));
  golden(JSON.parse(JSON.stringify(hotel)), "catalog");
});

test("region layers combine as recorded", () => {
  const view = runbook.view({ focus: ["main"], skip: ["footer", "nav"] }, null, {
    focus: ["nav", "form"],
    skip: ["main"],
  });
  golden(toJson(view), "view");
});
