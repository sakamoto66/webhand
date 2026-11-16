/** Model contracts with stubbed transports. Tests must never call a paid API. */

import { expect, test, vi } from "vitest";
import { summarize } from "../src/metrics.ts";
import { actionSpace, modelState, resolve } from "../src/policies/base.ts";
import { buildQuestions, estimateTokens, type Fetch, JevPolicy, validateChoice } from "../src/policies/jev.ts";
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
function jevPolicy(handler: (request: unknown) => { status: number; body?: unknown }) {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const sent: { url: string; body: unknown }[] = [];
  const fetch: Fetch = async (url, init) => {
    const request = JSON.parse(init.body);
    sent.push({ url, body: request });
    const { status, body } = handler(request);
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

test("a Jev HTTP error keeps the status, the request size and the start of the error body", async () => {
  const { policy, sent } = jevPolicy(() => ({ status: 400, body: { error: { message: "x".repeat(600) } } }));
  const error = (await policy.choose(PAGE, PLAN, []).catch((e: unknown) => e)) as PolicyError;
  expect(error.message).toBe("Jev returned HTTP 400; no action executed.");
  const diagnostic = error.diagnostic as Record<string, unknown>;
  expect(diagnostic.http_status).toBe(400);
  expect(diagnostic.request_chars).toBe(JSON.stringify(sent[0].body).length);
  expect(String(diagnostic.error)).toMatch(/^\{"error":\{"message":"x+$/);
  expect(String(diagnostic.error)).toHaveLength(500);
});

/** A page with links in view and below it, for requests over Jev's limits. */
function bigPage(inView: number, below: number, label = (i: number) => `Item ${i}`) {
  const link = (i: number, extra: object) => ({
    id: `e${i}`,
    kind: "click",
    node: i,
    role: "link",
    label: label(i),
    value: "",
    ...extra,
  });
  return {
    url: "http://local",
    title: "T",
    text: "text",
    actions: [
      ...Array.from({ length: inView }, (_, i) => link(i + 1, {})),
      ...Array.from({ length: below }, (_, i) =>
        link(inView + i + 1, { at: `below ${(i + 1) * 100}px`, offscreen: true }),
      ),
      { id: "wait", kind: "wait", label: "Wait for the page to update" },
    ],
  };
}

/** Jev clicks element 2, whatever the click choices offered. */
// biome-ignore lint/suspicious/noExplicitAny: a request body as JSON.
const clickTwo = (request: any) => {
  const answer = jevAnswer();
  const keys = Object.keys(request.questions.click_target.criteria);
  answer.answers.click_target.probabilities = Object.fromEntries(keys.map((k) => [k, k === "2" ? 1 : 0]));
  answer.answers.operation.probabilities = Object.fromEntries(
    Object.keys(request.questions.operation.criteria).map((k) => [k, k === "CLICK" ? 1 : 0]),
  );
  return { status: 200, body: answer };
};

// biome-ignore lint/suspicious/noExplicitAny: a request body as JSON.
const clickChoices = (body: any) => Object.keys(body.questions.click_target.criteria);

test("a small request goes to Jev whole", async () => {
  const { policy, sent } = jevPolicy(clickTwo);
  await policy.choose(bigPage(5, 5), PLAN, []);
  expect(clickChoices(sent[0].body)).toHaveLength(11);
  expect(policy.calls[0].dropped_elements).toBeUndefined();
});

test("over 255 choices, the farthest elements beyond the viewport are left out", async () => {
  const { policy, sent } = jevPolicy(clickTwo);
  const decision = await policy.choose(bigPage(5, 400), PLAN, []);
  const choices = clickChoices(sent[0].body);
  expect(choices.length).toBeLessThanOrEqual(255);
  // biome-ignore lint/suspicious/noExplicitAny: a request body as JSON.
  const labels = (sent[0].body as any).state.elements.map((e: { label: string }) => e.label);
  expect(labels.slice(0, 6)).toEqual(["Item 1", "Item 2", "Item 3", "Item 4", "Item 5", "Item 6"]);
  expect(labels).not.toContain("Item 405");
  expect(policy.calls[0].dropped_elements).toBe(405 - labels.length);
  // The answer is read against the page Jev was asked about.
  expect(decision.action?.label).toBe("Item 2");
});

test("over the token budget, elements in view are left out from the end", async () => {
  const { policy, sent } = jevPolicy(clickTwo);
  await policy.choose(
    bigPage(200, 0, (i) => `商品${i} ${"説明".repeat(150)}`),
    PLAN,
    [],
  );
  const request = JSON.stringify(sent[0].body);
  expect(estimateTokens(request)).toBeLessThanOrEqual(40_000);
  // biome-ignore lint/suspicious/noExplicitAny: a request body as JSON.
  const labels = (sent[0].body as any).state.elements.map((e: { label: string }) => e.label);
  expect(labels[0]).toMatch(/^商品1 /);
  expect(labels.length).toBeLessThan(200);
  expect(clickChoices(sent[0].body)).toContain("NOT_VISIBLE");
});

test("tokens are estimated at about 3 ASCII characters a token and 1.5 tokens for each other character", () => {
  expect([estimateTokens("abcdef"), estimateTokens("商品"), estimateTokens("ab商")]).toEqual([2, 3, 3]);
});

const overLimit = { status: 400, body: { detail: { error_type: "max_tokens_exceeded" } } };

/** A click answer whose usage says Jev counted `factor` times the estimate. */
// biome-ignore lint/suspicious/noExplicitAny: a request body as JSON.
const countedAs = (request: any, factor: number) => {
  const answer = clickTwo(request);
  answer.body.usage = { input_tokens: Math.floor(estimateTokens(JSON.stringify(request)) * factor), output_tokens: 5 };
  return answer;
};

test("refused over its limit, the request is fitted again to a lower limit, which comes back with each request that goes through", async () => {
  let refusals = 1;
  const { policy, sent } = jevPolicy((request) => (refusals-- > 0 ? overLimit : countedAs(request, 1)));
  const decision = await policy.choose(bigPage(5, 200), PLAN, []);
  expect(decision.action?.label).toBe("Item 2");
  expect(sent).toHaveLength(2);
  const sizes = sent.map((s) => estimateTokens(JSON.stringify(s.body)));
  const lowered = Math.floor(sizes[0] * 0.8);
  expect(sizes[1]).toBeLessThanOrEqual(lowered);
  expect(policy.calls[0].token_budget).toBe(lowered);
  // What was refused is logged as counts only.
  expect(policy.calls[0].refused).toEqual([
    {
      estimated_tokens: sizes[0],
      request_chars: JSON.stringify(sent[0].body).length,
      choices: expect.any(Number),
      elements: 205,
      budget: 36_000,
    },
  ]);
  // The request that went through lets the limit come back by a tenth.
  await policy.choose(bigPage(5, 200), PLAN, []);
  const next = estimateTokens(JSON.stringify(sent[2].body));
  expect(next).toBeLessThanOrEqual(Math.ceil(lowered * 1.1));
  expect(next).toBeGreaterThan(sizes[1]);
});

test("the estimate is scaled by what Jev counted for the last request, so more of a page is asked about", async () => {
  const labels = (i: number) => `商品${i} ${"説明".repeat(150)}`;
  const { policy, sent } = jevPolicy((request) => countedAs(request, 0.5));
  await policy.choose(bigPage(200, 0, labels), PLAN, []);
  await policy.choose(bigPage(200, 0, labels), PLAN, []);
  const asked = sent.map((s) => (s.body as { state: { elements: unknown[] } }).state.elements.length);
  expect(asked[1]).toBeGreaterThan(asked[0]);
  expect(policy.calls[0].token_scale).toBeUndefined();
  expect(policy.calls[1].token_scale).toBeCloseTo(0.5, 1);
  expect(policy.calls[1].dropped_elements ?? 0).toBeLessThan(policy.calls[0].dropped_elements ?? 0);
});

test("refused over its limit three times, Jev's refusal stands and nothing is chosen", async () => {
  const { policy, sent } = jevPolicy(() => overLimit);
  const error = (await policy.choose(bigPage(5, 200), PLAN, []).catch((e: unknown) => e)) as PolicyError;
  expect(error.message).toMatch(/HTTP 400/);
  expect(sent).toHaveLength(3);
  expect(error.diagnostic?.refused).toHaveLength(3);
});

test("another HTTP 400 is not fitted again", async () => {
  const { policy, sent } = jevPolicy(() => ({ status: 400, body: { detail: "bad" } }));
  await expect(policy.choose(bigPage(5, 200), PLAN, [])).rejects.toThrow(/HTTP 400/);
  expect(sent).toHaveLength(1);
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

test("Claude's answers reach Jev only when there are some, and ESCALATE is offered only in v2", () => {
  const plan: Plan = { goal: "g", steps: [], values: [] };
  const page = { url: "u", title: "t", text: "x", actions: [] };
  expect("claude_instructions" in (modelState(page, [], plan).plan as object)).toBe(false);
  const answered = { ...plan, instructions: ["Use the second tab"] };
  expect((modelState(page, [], answered).plan as { claude_instructions: string[] }).claude_instructions).toEqual([
    "Use the second tab",
  ]);
  const [, v1] = buildQuestions(plan, new Map(), new Map(), new Map());
  const [, v2] = buildQuestions({ ...plan, flow: "v2" }, new Map(), new Map(), new Map());
  expect(Object.keys(v1)).not.toContain("ESCALATE");
  expect(Object.keys(v2)).toContain("ESCALATE");
});
