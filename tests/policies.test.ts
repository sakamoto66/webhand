/** Model contracts with stubbed transports. Tests must never call a paid API. */

import { expect, test, vi } from "vitest";
import { refusal } from "../src/agent/readonly.ts";
import { summarize } from "../src/core/metrics.ts";
import { modelCall, type Plan, PolicyError } from "../src/core/types.ts";
import { render } from "../src/output.ts";
import { actionSpace, modelState, resolve } from "../src/policies/base.ts";
import { type Fetch, JevPolicy, validateChoice } from "../src/policies/jev.ts";
import { estimateTokens } from "../src/policies/jev-fit.ts";
import { buildQuestions } from "../src/policies/jev-questions.ts";
import { ScriptedPolicy } from "../src/policies/scripted.ts";

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
  // Every request's size is logged as counts, so a refusal can be set beside the requests that went through.
  expect(policy.calls[0].request).toEqual({
    estimated_tokens: estimateTokens(JSON.stringify(sent[0].body)),
    request_chars: JSON.stringify(sent[0].body).length,
    choices: expect.any(Number),
    elements: 10,
  });
  expect(policy.calls[0].dropped_elements).toBeUndefined();
  expect(policy.calls[0].dropped_breakdown).toBeUndefined();
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
  expect(policy.calls[0].dropped_breakdown).toEqual({
    in_view: 0,
    offscreen: 405 - labels.length,
    by_operation: { CLICK: 405 - labels.length },
    by_stage: { choice_limit: 405 - labels.length, token_budget: 0 },
  });
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
  expect(estimateTokens(request)).toBeLessThanOrEqual(24_000);
  // biome-ignore lint/suspicious/noExplicitAny: a request body as JSON.
  const labels = (sent[0].body as any).state.elements.map((e: { label: string }) => e.label);
  expect(labels[0]).toMatch(/^商品1 /);
  expect(labels.length).toBeLessThan(200);
  expect(clickChoices(sent[0].body)).toContain("NOT_VISIBLE");
  expect(policy.calls[0].dropped_breakdown).toEqual({
    in_view: 200 - labels.length,
    offscreen: 0,
    by_operation: { CLICK: 200 - labels.length },
    by_stage: { choice_limit: 0, token_budget: 200 - labels.length },
  });
});

test("the breakdown of left-out elements counts both stages, in view and beyond, and holds no page content", async () => {
  const { policy, sent } = jevPolicy(clickTwo);
  const page = bigPage(200, 100, (i) => `商品${i} ${"説明".repeat(150)}`);
  // Element 1 can be typed in and clicked: an element counts once in the total and once under each operation.
  page.actions.push({ id: "f300", kind: "fill", node: 300, role: "textbox", label: "Last", value: "" });
  await policy.choose(page, PLAN, []);
  // biome-ignore lint/suspicious/noExplicitAny: a request body as JSON.
  const asked = (sent[0].body as any).state.elements.length;
  const call = policy.calls[0];
  const dropped = 300 - asked;
  expect(call.dropped_elements).toBe(dropped);
  expect(call.dropped_breakdown).toEqual({
    in_view: dropped - 100,
    offscreen: 100,
    by_operation: { CLICK: dropped, TYPE_TEXT: 1 },
    // 300 click choices and NOT_VISIBLE are 46 over the limit of 255; the budget takes the rest.
    by_stage: { choice_limit: 46, token_budget: dropped - 46 },
  });
  expect(JSON.stringify(call)).not.toMatch(/商品|説明|Last/);
});

test("tokens are estimated at about 3 ASCII characters a token and 1.5 tokens for each other character", () => {
  expect([estimateTokens("abcdef"), estimateTokens("商品"), estimateTokens("ab商")]).toEqual([2, 3, 3]);
});

const overLimit = { status: 400, body: { detail: { error_type: "max_tokens_exceeded" } } };

test("refused over its limit, the request is fitted again to a lower budget, which the run keeps", async () => {
  let refusals = 1;
  const { policy, sent } = jevPolicy((request) => (refusals-- > 0 ? overLimit : clickTwo(request)));
  const decision = await policy.choose(bigPage(5, 200), PLAN, []);
  expect(decision.action?.label).toBe("Item 2");
  expect(sent).toHaveLength(2);
  const sizes = sent.map((s) => estimateTokens(JSON.stringify(s.body)));
  expect(sizes[1]).toBeLessThanOrEqual(Math.floor(sizes[0] * 0.6));
  expect(policy.calls[0].token_budget).toBe(Math.floor(sizes[0] * 0.6));
  // What was refused is logged as counts only.
  expect(policy.calls[0].refused).toEqual([
    {
      estimated_tokens: sizes[0],
      request_chars: JSON.stringify(sent[0].body).length,
      choices: expect.any(Number),
      elements: 205,
      budget: 24_000,
    },
  ]);
  await policy.choose(bigPage(5, 200), PLAN, []);
  expect(estimateTokens(JSON.stringify(sent[2].body))).toBeLessThanOrEqual(sizes[1]);
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

test("what worked before on this kind of page reaches Jev's state only when there is something", () => {
  expect(modelState(PAGE, [], PLAN).known_from_earlier_runs).toBeUndefined();
  const state = modelState(
    { ...PAGE, known: [{ operation: "CLICK", label: "More", worked: "1 of 2 tries" }] },
    [],
    PLAN,
  );
  expect(state.known_from_earlier_runs).toMatchObject({ operations: [{ label: "More" }] });
});

test("when select choices exceed 255, fitChoose drops the largest select without dropping buttons or inputs", async () => {
  const actions = [
    { id: "e1", kind: "fill", node: 1, role: "textbox", label: "Street", value: "" },
    { id: "e2", kind: "click", node: 1, role: "textbox", label: "Open Street", value: "" },
    ...Array.from({ length: 248 }, (_, i) => ({
      id: `ec${i + 1}`,
      kind: "select",
      node: 2,
      role: "combobox",
      label: `Country → Country ${i + 1}`,
      value: `C${i + 1}`,
      current_value: "United States",
    })),
    ...Array.from({ length: 60 }, (_, i) => ({
      id: `es${i + 1}`,
      kind: "select",
      node: 3,
      role: "combobox",
      label: `State → State ${i + 1}`,
      value: `S${i + 1}`,
      current_value: "California",
    })),
    { id: "e4", kind: "fill", node: 4, role: "textbox", label: "City", value: "" },
    { id: "e5", kind: "click", node: 4, role: "textbox", label: "Open City", value: "" },
    { id: "e6", kind: "click", node: 5, role: "button", label: "Save Order Address", value: "" },
    { id: "wait", kind: "wait", label: "Wait for the page to update" },
  ];
  const page = { url: "http://local/address", title: "Address", text: "Address", actions };
  const { policy, sent } = jevPolicy((request) => {
    // biome-ignore lint/suspicious/noExplicitAny: a request body as JSON.
    const req = request as any;
    const answer = jevAnswer();
    const clickKeys = Object.keys(req.questions.click_target.criteria);
    const saveKey = clickKeys.find((k) =>
      req.questions.click_target.criteria[k]?.element?.includes("Save Order Address"),
    );
    answer.answers.click_target = {
      choice: saveKey,
      confidence: 0.9,
      probabilities: Object.fromEntries(clickKeys.map((k) => [k, k === saveKey ? 1 : 0])),
    };
    answer.answers.operation.probabilities = Object.fromEntries(
      Object.keys(req.questions.operation.criteria).map((k) => [k, k === "CLICK" ? 1 : 0]),
    );
    return { status: 200, body: answer };
  });
  const decision = await policy.choose(page, PLAN, []);
  expect(decision.action?.label).toBe("Save Order Address");
  // biome-ignore lint/suspicious/noExplicitAny: a request body as JSON.
  const body = sent[0].body as any;
  const labels = body.state.elements.map((e: { label: string }) => e.label);
  expect(labels).toEqual(["Street", "State", "City", "Save Order Address"]);
  expect(Object.keys(body.questions.select_target.criteria)).toHaveLength(61);
  expect(policy.calls[0].dropped_elements).toBe(1);
  expect(policy.calls[0].dropped_breakdown).toEqual({
    in_view: 1,
    offscreen: 0,
    by_operation: { SELECT: 1 },
    by_stage: { choice_limit: 1, token_budget: 0 },
  });
});

test("HOVER and duplicate-element context propagate through actionSpace, render, modelState, questions, and readonly", () => {
  const page = {
    url: "http://local/mr",
    title: "MR",
    text: "Assignee Edit Reviewers Edit",
    actions: [
      { id: "e1", kind: "click", node: 1, role: "link", label: "Repository", value: "" },
      { id: "e2", kind: "hover", node: 1, role: "link", label: "Repository", value: "" },
      { id: "e3", kind: "click", node: 2, role: "link", label: "Edit", context: "Assignee", value: "" },
      { id: "e4", kind: "click", node: 3, role: "link", label: "Edit", context: "0 Reviewers", value: "" },
      { id: "wait", kind: "wait", label: "Wait for the page to update" },
    ],
  };
  const [elements, targets, controls] = actionSpace(page.actions);
  expect(elements[0].operations).toEqual(["CLICK", "HOVER"]);
  expect(elements[1].context).toBe("Assignee");
  expect(elements[2].context).toBe("0 Reviewers");

  const rendered = render(page);
  expect(rendered).toContain('[1] link "Repository"  (CLICK,HOVER)');
  expect(rendered).toContain('[2] link "Edit" context="Assignee" (CLICK)');
  expect(rendered).toContain('[3] link "Edit" context="0 Reviewers" (CLICK)');

  const state = modelState(page, [], PLAN) as { elements: Array<{ context?: string; operations: string[] }> };
  expect(state.elements[0].operations).toEqual(["CLICK", "HOVER"]);
  expect(state.elements[2].context).toBe("0 Reviewers");

  const [questions, ops] = buildQuestions(PLAN, targets, controls, new Map());
  expect("HOVER" in ops).toBe(true);
  // biome-ignore lint/suspicious/noExplicitAny: inspecting question structure.
  const q = questions as any;
  expect(q.hover_target.criteria.get("1")).toMatchObject({ element: "[1] Repository", role: "link" });
  expect(q.click_target.criteria.get("3")).toMatchObject({ element: "[3] Edit", context: "0 Reviewers" });

  const resolved = resolve(page, "HOVER", "1");
  expect(resolved.action?.kind).toBe("hover");
  expect(resolved.action ? refusal(resolved.action, { allow: [] }) : "missing").toBeNull();
});

test("render supports compact handoff modes: omitting elements, omitting offscreen elements, and capping options", () => {
  const page = {
    url: "http://local/list",
    title: "List",
    text: "Summary text",
    actions: [
      { id: "e1", kind: "click", node: 1, role: "button", label: "Apply", value: "" },
      { id: "e2", kind: "click", node: 2, role: "link", label: "Far row", at: "below 900px", offscreen: true },
      { id: "e3", kind: "click", node: 3, role: "link", label: "Farther row", at: "below 1400px", offscreen: true },
      ...Array.from({ length: 15 }, (_, i) => ({
        id: `s${i + 1}`,
        kind: "select",
        node: 4,
        role: "combobox",
        label: `Country → Country ${i + 1}`,
        value: `c${i + 1}`,
        current_value: "Japan",
      })),
      { id: "wait", kind: "wait", label: "Wait" },
    ],
  };

  // GOAL_REPORTED mode: omits element list entirely while keeping URL, title, page text, and count.
  const noElements = render(page, { elements: false });
  expect(noElements).toContain("Summary text");
  expect(noElements).toContain("ELEMENTS: 4 omitted (run observe to inspect indices)");
  expect(noElements).not.toContain('[1] button "Apply"');

  // Escalation report mode: keeps visible elements, omits offscreen elements, and caps huge select option lists.
  const compact = render(page, { offscreenElements: false, maxOptions: 3 });
  expect(compact).toContain('[1] button "Apply"');
  expect(compact).not.toContain("Far row");
  expect(compact).toContain("... 2 offscreen elements omitted (run observe to list all)");
  expect(compact).toContain("  [4:3] Country 3");
  expect(compact).not.toContain("  [4:4] Country 4");
  expect(compact).toContain("  ... 12 more options (run observe to list all)");

  // Default observe/act mode remains complete.
  const full = render(page);
  expect(full).toContain("Far row");
  expect(full).toContain("  [4:15] Country 15");
});
