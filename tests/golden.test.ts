/**
 * What Claude and Jev read must not change with the language. These outputs were recorded from the
 * Python implementation (tests/golden) and are compared character for character.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import type { AgentResult } from "../src/agent.ts";
import { captured, describePlan, recentActions, render, report } from "../src/cli.ts";
import { actionSpace, modelState, valueChoices } from "../src/policies/base.ts";
import { buildQuestions, JevPolicy } from "../src/policies/jev.ts";
import { pyJson } from "../src/py.ts";
import * as runbook from "../src/runbook.ts";
import { type Page, type Plan, PolicyError } from "../src/types.ts";
import { ROOT } from "./helpers.ts";

const GOLDEN = join(ROOT, "tests", "golden");
const pages: Record<string, Page> = JSON.parse(readFileSync(join(GOLDEN, "pages.json"), "utf8"));
// biome-ignore lint/suspicious/noExplicitAny: recorded outputs.
const cases: Record<string, any> = JSON.parse(readFileSync(join(GOLDEN, "cases.json"), "utf8"));

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

test.each(Object.keys(pages))("page %s renders, states, and asks as before", (name) => {
  const page = pages[name];
  const expected = cases[name];
  const [, targets, controls] = actionSpace(page.actions);
  const [questions, operations] = buildQuestions(plan, targets, controls, valueChoices(plan));
  expect(render(page)).toBe(expected.render);
  expect(pyJson(modelState(page, history, plan))).toBe(expected.model_state);
  expect(pyJson(modelState(page, []))).toBe(expected.model_state_noplan);
  expect(pyJson(questions)).toBe(expected.questions);
  expect(pyJson(operations)).toBe(expected.operations);
});

test.each(Object.keys(pages))("the request to Jev for page %s is byte for byte as before", async (name) => {
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
  expect(body).toBe(cases[name].body);
});

test("plans and recent actions print as before", () => {
  const state = { plan, history, max_attempts: 3, page: pages.tricky };
  expect(describePlan(plan, { focus: ["form", "x"], skip: [] })).toBe(cases.describe_plan);
  expect(describePlan({ goal: "g", steps: [], values: [] }, null)).toBe(cases.describe_plan_goal_only);
  expect(recentActions(state)).toBe(cases.recent_actions);
  expect(recentActions({ ...state, history: [] })).toBe(cases.recent_actions_empty);
});

test.each(Object.keys(cases.report))("the %s report prints as before", (outcome) => {
  const state = { plan, history, max_attempts: 3, page: pages.tricky };
  const result = {
    outcome,
    detail: "detail 'x'",
    field: { label: "Name's", role: "textbox", value: null },
  } as unknown as AgentResult;
  const { result: code, text } = captured(() => report(state, result));
  expect({ code, text }).toEqual(cases.report[outcome]);
});

/** Drops what the TypeScript version adds: the scope each file was read from. */
function withoutScope(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutScope);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "scope")
        .map(([key, item]) => [key, withoutScope(item)]),
    );
  }
  return value;
}

test("the repository's runbooks load and list as before", () => {
  const loaded = runbook.load("hotel/filter", { city: "Lisbon", category: "Design", stay: "Casa Flora" });
  loaded.start_url = loaded.start_url.replace(pathToFileURL(ROOT).href, "ROOT");
  expect(withoutScope({ "hotel/filter": loaded })).toEqual(JSON.parse(cases.runbook_load));
  const before = JSON.parse(cases.catalog).filter((entry: { service: string }) => entry.service.startsWith("hotel"));
  expect(withoutScope(runbook.catalog())).toEqual(before);
});

test("region layers combine as before", () => {
  const view = runbook.view({ focus: ["main"], skip: ["footer", "nav"] }, null, {
    focus: ["nav", "form"],
    skip: ["main"],
  });
  expect(pyJson(view)).toBe(cases.view);
});
