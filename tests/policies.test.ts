/** Model contracts with stubbed transports. Tests must never call a paid API. */

import { expect, test, vi } from "vitest";
import { summarize } from "../src/metrics.ts";
import { actionSpace, modelState, resolve } from "../src/policies/base.ts";
import { type Fetch, JevPolicy, validateChoice } from "../src/policies/jev.ts";
import { ScriptedPolicy } from "../src/policies/scripted.ts";
import { modelCall, type Plan, PolicyError } from "../src/types.ts";

const PAGE = {
  url: "http://local",
  title: "T",
  text: "text",
  actions: [
    { id: "e1", kind: "fill", node: 1, role: "textbox", label: "City", value: "" },
    { id: "e2", kind: "click", node: 1, role: "textbox", label: "Open City", value: "" },
    { id: "e3", kind: "click", node: 2, role: "button", label: "Go", value: "" },
    { id: "e4", kind: "select", node: 3, role: "combobox", label: "Kind → A", value: "a" },
    { id: "wait", kind: "wait", label: "Wait for the page to update" },
  ],
};

test("the action space uses one index per node", () => {
  const [elements, targets, controls] = actionSpace(PAGE.actions);
  expect(elements.map((e) => e.index)).toEqual(["1", "2", "3"]);
  expect(elements[0].operations).toEqual(["TYPE_TEXT", "CLICK"]);
  expect(targets.get("SELECT")?.get("3:1")?.id).toBe("e4");
  expect(controls.has("WAIT")).toBe(true);
});

test.each([
  ["CLICK", "99"],
  ["CLICK", null],
  ["TYPE_TEXT", "2"],
  ["SCROLL_DOWN", null],
  ["rm -rf", "1"],
])("resolve rejects anything unobserved: %s %s", (operation, target) => {
  expect(() => resolve(PAGE, operation, target)).toThrow(PolicyError);
});

const PLAN: Plan = {
  goal: "goal",
  steps: [{ instruction: "Go", actor: "jev" }],
  values: [{ label: "City", value: "Lisbon" }],
};

// biome-ignore lint/suspicious/noExplicitAny: a Jev response as JSON.
function jevAnswer(): any {
  return {
    model: "jev-1",
    usage: { input_tokens: 50, output_tokens: 5 },
    answers: {
      operation: {
        choice: "CLICK",
        confidence: 0.9,
        probabilities: { TYPE_TEXT: 0, CLICK: 1, SELECT: 0, WAIT: 0, DONE: 0, NEEDS_HUMAN: 0, BLOCKED: 0 },
      },
      click_target: { choice: "2", confidence: 0.9, probabilities: { "1": 0, "2": 1, NOT_VISIBLE: 0 } },
    },
  };
}

/** A JevPolicy whose requests go to handler. sent collects the request bodies. */
function jevPolicy(handler: () => { status: number; body?: unknown }) {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const sent: { url: string; body: unknown }[] = [];
  const fetch: Fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    const { status, body } = handler();
    return { status, json: async () => body };
  };
  return { policy: new JevPolicy({ fetch }), sent };
}

const ok = (body: unknown) => () => ({ status: 200, body });

test("Jev records tokens", async () => {
  const { policy } = jevPolicy(ok(jevAnswer()));
  const decision = await policy.choose(PAGE, PLAN, []);
  expect(decision.action?.id).toBe("e3");
  const call = policy.calls[0];
  expect([call.provider, call.input_tokens, call.output_tokens]).toEqual(["typesafe", 50, 5]);
  expect(decision.confidence).toBe(0.9);
});

test("an invalid Jev target is rejected", async () => {
  const answer = jevAnswer();
  answer.answers.click_target.choice = "99";
  await expect(jevPolicy(ok(answer)).policy.choose(PAGE, PLAN, [])).rejects.toThrow(PolicyError);
});

test("a Jev HTTP error is a policy error", async () => {
  await expect(jevPolicy(() => ({ status: 401 })).policy.choose(PAGE, PLAN, [])).rejects.toThrow(/HTTP 401/);
});

test("a busy Jev is asked at most three times", async () => {
  let count = 0;
  const { policy } = jevPolicy(() => {
    count += 1;
    return { status: 503 };
  });
  await expect(policy.choose(PAGE, PLAN, [])).rejects.toThrow(/HTTP 503/);
  expect(count).toBe(3);
});

test("a failed connection is a policy error", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const policy = new JevPolicy({
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await expect(policy.choose(PAGE, PLAN, [])).rejects.toThrow(/connection failed/);
});

test("validateChoice rejects wrong probabilities", () => {
  expect(() => validateChoice({ choice: "a", confidence: 1, probabilities: { a: 0.1, b: 0.9 } }, ["a", "b"])).toThrow(
    PolicyError,
  );
  expect(() => validateChoice({ choice: "a", confidence: true, probabilities: { a: 1, b: 0 } }, ["a", "b"])).toThrow(
    PolicyError,
  );
  expect(validateChoice({ choice: "a", confidence: 1, probabilities: { a: 1, b: 0 } }, ["a", "b"]).choice).toBe("a");
});

test("the summary totals tokens per provider", () => {
  const calls = [modelCall("typesafe", "j", "choose", 1, 20, 2), modelCall("typesafe", "j", "choose", 1)];
  expect(summarize(calls).providers.typesafe).toEqual({ calls: 2, input_tokens: 20, output_tokens: 2 });
});

test("a scripted step is retried until it reaches the history", async () => {
  const policy = new ScriptedPolicy([
    { operation: "CLICK", label: "Go" },
    { operation: "TYPE_TEXT", label: "City", text: "Lisbon" },
  ]);
  const history: Record<string, unknown>[] = [];
  expect((await policy.choose(PAGE, PLAN, history)).action?.id).toBe("e3");
  // The click raised StalePage, so nothing was recorded: the same step comes back.
  expect((await policy.choose(PAGE, PLAN, history)).action?.id).toBe("e3");
  history.push({ action: "Go" });
  const decision = await policy.choose(PAGE, PLAN, history);
  expect(decision.action?.id).toBe("e1");
  expect(decision.text).toBe("Lisbon");
  history.push({ action: "City" });
  expect((await policy.choose(PAGE, PLAN, history)).operation).toBe("DONE");
});

test("a scripted control step without a label", async () => {
  const policy = new ScriptedPolicy([{ operation: "WAIT" }]);
  expect((await policy.choose(PAGE, PLAN, [])).operation).toBe("WAIT");
  await expect(new ScriptedPolicy([{ operation: "SCROLL_UP" }]).choose(PAGE, PLAN, [])).rejects.toThrow(PolicyError);
});

function typeAnswer(valueChoice: string) {
  const answer = jevAnswer();
  const operation = answer.answers.operation;
  operation.choice = "TYPE_TEXT";
  operation.probabilities = {
    ...Object.fromEntries(Object.keys(operation.probabilities).map((k) => [k, 0])),
    TYPE_TEXT: 1,
  };
  answer.answers.type_text_target = { choice: "1", confidence: 0.8, probabilities: { "1": 1, NOT_VISIBLE: 0 } };
  answer.answers.type_text_value = {
    choice: valueChoice,
    confidence: 0.7,
    probabilities: { "1": valueChoice === "1" ? 1 : 0, NONE: valueChoice === "NONE" ? 1 : 0 },
  };
  return answer;
}

test("Jev chooses one of Claude's values by number", async () => {
  const { policy, sent } = jevPolicy(ok(typeAnswer("1")));
  const decision = await policy.choose(PAGE, PLAN, []);
  expect([decision.action?.id, decision.text, decision.confidence]).toEqual(["e1", "Lisbon", 0.7]);
  // biome-ignore lint/suspicious/noExplicitAny: the request body as JSON.
  const body = sent[0].body as any;
  expect(body.questions.type_text_value.criteria).toEqual({
    "1": "City: Lisbon",
    NONE: "No listed value belongs in the field",
  });
  expect(body.state.plan.steps).toEqual(["1. Go"]);
  expect("NEEDS_HUMAN" in body.questions.operation.criteria).toBe(true);
});

test("Jev choosing no value leaves the text empty", async () => {
  const decision = await jevPolicy(ok(typeAnswer("NONE"))).policy.choose(PAGE, PLAN, []);
  expect(decision.operation).toBe("TYPE_TEXT");
  expect(decision.text).toBeNull();
});

test("Jev cannot invent a value", async () => {
  const answer = typeAnswer("1");
  answer.answers.type_text_value.choice = "Porto";
  await expect(jevPolicy(ok(answer)).policy.choose(PAGE, PLAN, [])).rejects.toThrow(PolicyError);
});

test("Jev is told how much of the page is offscreen", () => {
  const page = { ...PAGE, h: 780, scroll: { y: 444, height: 1310 } };
  // biome-ignore lint/suspicious/noExplicitAny: the state as JSON.
  expect((modelState(page, [], PLAN) as any).page.offscreen).toEqual({ above_px: 444, below_px: 86 });
  const top = { ...PAGE, h: 780, scroll: { y: 0, height: 500 } };
  // biome-ignore lint/suspicious/noExplicitAny: the state as JSON.
  expect((modelState(top, [], PLAN) as any).page.offscreen).toEqual({ above_px: 0, below_px: 0 });
});

test("Jev can say the needed target is not visible", async () => {
  const answer = jevAnswer();
  answer.answers.click_target = {
    choice: "NOT_VISIBLE",
    confidence: 0.8,
    probabilities: { "1": 0, "2": 0, NOT_VISIBLE: 1 },
  };
  const { policy, sent } = jevPolicy(ok(answer));
  const decision = await policy.choose(PAGE, PLAN, []);
  expect([decision.operation, decision.action, decision.wanted]).toEqual(["NOT_VISIBLE", null, "CLICK"]);
  // biome-ignore lint/suspicious/noExplicitAny: the request body as JSON.
  expect("NOT_VISIBLE" in (sent[0].body as any).questions.click_target.criteria).toBe(true);
});

test("dropdown options reach Jev once each in short form", async () => {
  const { policy, sent } = jevPolicy(ok(jevAnswer()));
  await policy.choose(PAGE, PLAN, []);
  // biome-ignore lint/suspicious/noExplicitAny: the request body as JSON.
  const body = sent[0].body as any;
  const kind = body.state.elements.find((e: { label: string }) => e.label === "Kind");
  expect(kind.options).toEqual({ "3:1": "A" });
  expect(body.questions.select_target.criteria["3:1"]).toBe("[3:1] Kind → A");
  // Choices are unchanged: the same index still resolves to the observed option.
  expect(resolve(PAGE, "SELECT", "3:1").action?.id).toBe("e4");
  // Claude's view of the page keeps the full option list.
  expect(actionSpace(PAGE.actions)[0][2].options[0].value).toBe("a");
});
