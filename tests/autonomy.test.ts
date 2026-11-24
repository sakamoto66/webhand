/**
 * Tests for Jev autonomy features:
 * 1. Two-stage Jev region narrowing + low-confidence full-page fallback
 * 2. Jev-as-a-Verifier (--expect completion claims)
 * 3. Non-destructive tactical recovery (--recover before STUCK)
 * 4. Read-only list-to-detail drilldown (`webhand drilldown`)
 * 5. Read-only one-shot query (`webhand query`)
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type Actor, Budget, runAgent } from "../src/agent/index.ts";
import { deps, OK } from "../src/commands/context.ts";
import { Recorder } from "../src/core/metrics.ts";
import {
  type ClaimVerdict,
  Decision,
  type HistoryEntry,
  type ModelCall,
  modelCall,
  type Page,
  type Plan,
  type Policy,
} from "../src/core/types.ts";
import { describePlan } from "../src/output.ts";
import { type Fetch, JevPolicy } from "../src/policies/jev.ts";
import { formatDrilldown, isAllowedDetailUrl, textBlocks } from "../src/scans/drilldown.ts";
import * as session from "../src/storage/session.ts";
import { cli, readEvents, tmpPath } from "./helpers.ts";
import { isolate } from "./jev.ts";

// biome-ignore lint/suspicious/noExplicitAny: mock Jev response helper.
function choiceResp(answers: Record<string, { choice: string; confidence?: number; keys: string[] }>): any {
  const out: Record<string, unknown> = {};
  for (const [q, { choice, confidence = 0.9, keys }] of Object.entries(answers)) {
    out[q] = {
      choice,
      confidence,
      probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0])),
    };
  }
  return { model: "jev-test", usage: { input_tokens: 20, output_tokens: 4 }, answers: out };
}

function multiRegionPage(): Page {
  const navLinks = Array.from({ length: 10 }, (_, i) => ({
    id: `n${i + 1}`,
    kind: "click",
    node: i + 1,
    role: "link",
    label: `Nav ${i + 1}`,
    region: "nav",
    value: "",
  }));
  const formButtons = Array.from({ length: 8 }, (_, i) => ({
    id: `f${i + 1}`,
    kind: "click",
    node: 100 + i + 1,
    role: "button",
    label: i === 0 ? "Apply Filters" : `Action ${i + 1}`,
    region: "main/form:Filters",
    value: "",
  }));
  return {
    url: "http://local/orders",
    title: "Orders",
    text: "Orders table and filters",
    actions: [...navLinks, ...formButtons, { id: "wait", kind: "wait", label: "Wait" }],
  };
}

test("two-stage Jev narrows a multi-region page in stage 1 and chooses within that region in stage 2", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const requests: Record<string, unknown>[] = [];
  const fetch: Fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    requests.push(req);
    if (req.questions.region) {
      const keys = Object.keys(req.questions.region.criteria);
      const formKey = keys.find((k) =>
        String(req.questions.region.criteria[k]).includes("main/form:Filters"),
      ) as string;
      return { status: 200, json: async () => choiceResp({ region: { choice: formKey, keys } }) };
    }
    const opKeys = Object.keys(req.questions.operation.criteria);
    const clickKeys = Object.keys(req.questions.click_target.criteria);
    const applyKey = clickKeys.find((k) =>
      JSON.stringify(req.questions.click_target.criteria[k]).includes("Apply Filters"),
    ) as string;
    return {
      status: 200,
      json: async () =>
        choiceResp({
          operation: { choice: "CLICK", keys: opKeys },
          click_target: { choice: applyKey, keys: clickKeys },
        }),
    };
  };
  const policy = new JevPolicy({ fetch });
  const plan: Plan = { goal: "Apply filters", steps: [], values: [], two_stage: true };
  const decision = await policy.choose(multiRegionPage(), plan, []);

  expect(decision.operation).toBe("CLICK");
  expect(decision.action?.label).toBe("Apply Filters");
  expect(requests).toHaveLength(2);
  expect(policy.calls.map((c) => c.purpose)).toEqual(["region", "choose"]);
  // Stage 2 only saw main/form:Filters elements, not the 10 nav links.
  // biome-ignore lint/suspicious/noExplicitAny: inspecting request body.
  const stage2Labels = (requests[1] as any).state.elements.map((e: { label: string }) => e.label);
  expect(stage2Labels).not.toContain("Nav 1");
  expect(stage2Labels).toContain("Apply Filters");
});

test("two-stage Jev falls back read-only to the full page on low confidence or NOT_VISIBLE", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  let call = 0;
  const fetch: Fetch = async (_url, init) => {
    call += 1;
    const req = JSON.parse(init.body);
    if (req.questions.region) {
      const keys = Object.keys(req.questions.region.criteria);
      return { status: 200, json: async () => choiceResp({ region: { choice: keys[0], keys } }) };
    }
    const opKeys = Object.keys(req.questions.operation.criteria);
    const clickKeys = Object.keys(req.questions.click_target.criteria);
    if (call === 2) {
      // Stage 2 in narrowed region has low confidence (0.3) -> triggers full-page fallback.
      return {
        status: 200,
        json: async () =>
          choiceResp({
            operation: { choice: "CLICK", confidence: 0.3, keys: opKeys },
            click_target: { choice: clickKeys[0], confidence: 0.3, keys: clickKeys },
          }),
      };
    }
    const applyKey = clickKeys.find((k) =>
      JSON.stringify(req.questions.click_target.criteria[k]).includes("Apply Filters"),
    ) as string;
    return {
      status: 200,
      json: async () =>
        choiceResp({
          operation: { choice: "CLICK", confidence: 0.95, keys: opKeys },
          click_target: { choice: applyKey, confidence: 0.95, keys: clickKeys },
        }),
    };
  };
  const policy = new JevPolicy({ fetch });
  const decision = await policy.choose(
    multiRegionPage(),
    { goal: "Apply filters", steps: [], values: [], two_stage: true },
    [],
  );
  expect(call).toBe(3); // region -> narrowed -> full fallback
  expect(decision.action?.label).toBe("Apply Filters");
  expect(decision.confidence).toBe(0.95);
});

test("JevPolicy.verifyClaims, recover, and selectBlocks validate parallel structured choices", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const fetch: Fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    if (req.questions.claim_1) {
      return {
        status: 200,
        json: async () =>
          choiceResp({
            claim_1: { choice: "MET", keys: ["MET", "NOT_MET", "UNKNOWN"] },
            claim_2: { choice: "NOT_MET", keys: ["MET", "NOT_MET", "UNKNOWN"] },
          }),
      };
    }
    if (req.questions.recovery) {
      const keys = Object.keys(req.questions.recovery.criteria);
      return {
        status: 200,
        json: async () => choiceResp({ recovery: { choice: "RESET_FILTERS", confidence: 0.85, keys } }),
      };
    }
    if (req.questions.block_1) {
      return {
        status: 200,
        json: async () =>
          choiceResp({
            block_1: { choice: "NO", keys: ["MATCH", "NO"] },
            block_2: { choice: "MATCH", keys: ["MATCH", "NO"] },
          }),
      };
    }
    throw new Error("Unexpected request");
  };
  const policy = new JevPolicy({ fetch });
  const page = multiRegionPage();
  const plan: Plan = { goal: "Check orders", steps: [], values: [] };

  const verdicts = await policy.verifyClaims(page, plan, ["On Orders page", "Filtered to Complete"]);
  expect(verdicts.get("On Orders page")).toBe("MET");
  expect(verdicts.get("Filtered to Complete")).toBe("NOT_MET");

  const rec = await policy.recover(page, plan, []);
  expect(rec).toEqual({ strategy: "RESET_FILTERS", confidence: 0.85 });

  const matched = await policy.selectBlocks(page, plan, "grand total", [
    { key: "1", text: "Nav menu" },
    { key: "2", text: "Grand Total: $182.40" },
  ]);
  expect([...matched]).toEqual(["2"]);
  expect(policy.calls.map((c) => c.purpose)).toEqual(["verify", "recover", "select_blocks"]);
});

class OfflineBrowser implements Actor {
  acts: [string, string | null][] = [];
  scrollY = 0;
  marker = 0;
  staticMarker: string | null = null;
  async observe(): Promise<Page> {
    this.marker += 1;
    return {
      url: "http://local/p",
      title: "T",
      text: "body",
      scroll: { y: this.scrollY, height: 2000 },
      h: 700,
      actions: [{ id: "e1", kind: "click", label: "Filter", node: 1 }],
      marker: this.staticMarker ?? String(this.marker),
    };
  }
  async fresh(): Promise<boolean> {
    return true;
  }
  async act(action: Page, _page: Page, text: string | null = null): Promise<void> {
    this.acts.push([action.id, text]);
    if (action.kind === "scroll") this.scrollY = Math.max(0, this.scrollY + Number(action.delta ?? 0));
  }
}

test("Jev self-verification rejects premature DONE when an --expect claim is NOT_MET, then accepts when MET", async () => {
  const recorder = new Recorder(join(tmpPath(), "verify.jsonl"));
  const browser = new OfflineBrowser();
  const seenInstructions: string[][] = [];
  const decisions = [
    new Decision("DONE"),
    new Decision("CLICK", { id: "e1", kind: "click", label: "Filter", node: 1 }),
    new Decision("DONE"),
  ];
  const verifyRounds: ClaimVerdict[] = ["NOT_MET", "MET"];
  const policy: Policy = {
    name: "fake",
    calls: [] as ModelCall[],
    config: () => ({}),
    async choose(_page, plan) {
      seenInstructions.push([...(plan.instructions ?? [])]);
      this.calls.push(modelCall("p", "m", "choose", 1));
      return decisions.shift() as Decision;
    },
    async verifyClaims(_page, _plan, claims) {
      this.calls.push(modelCall("p", "m", "verify", 1));
      const v = verifyRounds.shift() ?? "MET";
      return new Map(claims.map((c) => [c, v]));
    },
  };
  const plan: Plan = { goal: "Filter complete orders", steps: [], values: [], expects: ["Status is Complete"] };
  const history: HistoryEntry[] = [];
  const result = await runAgent(browser, policy, plan, recorder, new Budget(), { history });
  recorder.close();

  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(result.actions).toBe(1); // The verify rejection does not count against action budget.
  expect(seenInstructions[1]?.some((s) => s.includes("Status is Complete"))).toBe(true);
  const events = readEvents(recorder.path).filter((e) => e.type === "self_verify");
  expect(events.map((e) => [e.met, e.unmet])).toEqual([
    [0, 1],
    [1, 0],
  ]);
});

test("non-destructive tactical recovery resets stuck window, scrolls to top when chosen, and respects ESCALATE_TO_HOST", async () => {
  const recorder = new Recorder(join(tmpPath(), "recover.jsonl"));
  const browser = new OfflineBrowser();
  browser.staticMarker = "unchanged";
  browser.scrollY = 500;
  const click = new Decision("CLICK", { id: "e1", kind: "click", label: "Filter", node: 1 });
  const decisions = [click, click, click, new Decision("DONE")];
  const policy: Policy = {
    name: "fake",
    calls: [],
    config: () => ({}),
    async choose() {
      return decisions.shift() as Decision;
    },
    async recover() {
      return { strategy: "SCROLL_TO_TOP", confidence: 0.9 };
    },
  };
  const history: HistoryEntry[] = [];
  const result = await runAgent(
    browser,
    policy,
    { goal: "g", steps: [], values: [], recover: true },
    recorder,
    new Budget(),
    { history },
  );
  recorder.close();

  expect(result.outcome).toBe("GOAL_REPORTED");
  expect(browser.scrollY).toBe(0);
  expect(history.some((h) => h.kind === "recovery")).toBe(true);
  expect(readEvents(recorder.path).filter((e) => e.type === "tactical_recovery")[0].strategy).toBe("SCROLL_TO_TOP");

  // ESCALATE_TO_HOST stops immediately as STUCK.
  const rec2 = new Recorder(join(tmpPath(), "recover-esc.jsonl"));
  const b2 = new OfflineBrowser();
  b2.staticMarker = "unchanged";
  const p2: Policy = {
    name: "fake",
    calls: [],
    config: () => ({}),
    async choose() {
      return click;
    },
    async recover() {
      return { strategy: "ESCALATE_TO_HOST", confidence: 0.95 };
    },
  };
  const r2 = await runAgent(b2, p2, { goal: "g", steps: [], values: [], recover: true }, rec2, new Budget());
  rec2.close();
  expect(r2.outcome).toBe("STUCK");
});

test("describePlan, drilldown helpers, and URL origin safety work as expected", () => {
  const planText = describePlan({
    goal: "Check reviews",
    steps: [],
    values: [],
    expects: ["Filtered by Circe"],
    two_stage: true,
    recover: true,
  });
  expect(planText).toContain("EXPECTS: Filtered by Circe");
  expect(planText).toContain("TWO-STAGE: on");
  expect(planText).toContain("RECOVER: on");

  expect(isAllowedDetailUrl("http://localhost:7780/admin/review/edit/1", "http://localhost:7780/admin/review/")).toBe(
    true,
  );
  expect(isAllowedDetailUrl("https://evil.example/steal", "http://localhost:7780/admin/review/")).toBe(false);
  expect(isAllowedDetailUrl("javascript:alert(1)", "http://localhost:7780/admin/review/")).toBe(false);

  const blocks = textBlocks({ text: `${"A".repeat(300)}\n${"B".repeat(300)}` });
  expect(blocks.length).toBeGreaterThanOrEqual(2);

  const md = formatDrilldown(
    {
      list_url: "http://local/list",
      match: "Circe",
      seen: 2,
      matched: 1,
      visited: 1,
      truncated: false,
      items: [{ row: "Circe row", url: "http://local/d1", title: "Review 1", fields: { Rating: "3 stars" } }],
    },
    "markdown",
  );
  expect(md).toContain("| title | Rating |");
  expect(md).toContain("| Review 1 | 3 stars |");
});

describe("real Chrome CLI: drilldown and one-shot read-only query", () => {
  let cleanup: () => Promise<void>;
  let dir: string;
  let listUrl: string;

  beforeEach(() => {
    ({ cleanup } = isolate());
    dir = tmpPath();
    writeFileSync(
      join(dir, "detail1.html"),
      `<title>Review #1</title><main>
        <script>window.__inlineNoise = "INLINE_JS_NOISE";</script>
        <fieldset><legend>Review Details</legend>
          <div class="admin__field">
            <label for="t">Title</label><input id="t" value="Too tight">
          </div>
          <div class="admin__field">
            <label for="pw">Secret</label><input id="pw" type="password" value="SHOULD_NEVER_READ">
          </div>
          <div class="admin__field">
            <label class="admin__field-label">Rating</label>
            <input type="radio" id="Rating_1" name="ratings[4]" value="16"><label for="Rating_1">★</label>
            <input type="radio" id="Rating_2" name="ratings[4]" value="17" checked><label for="Rating_2">★</label>
            <input type="radio" id="Rating_3" name="ratings[4]" value="18"><label for="Rating_3">★</label>
          </div>
        </fieldset>
      </main>`,
    );
    writeFileSync(
      join(dir, "detail2.html"),
      `<title>Review #2</title><main>
        <label for="t">Title</label><input id="t" value="Love it">
        <fieldset><legend>Rating</legend>
          <input type="radio" id="r5" name="rating" value="5" checked><label for="r5">5 stars</label>
        </fieldset>
      </main>`,
    );
    writeFileSync(
      join(dir, "list.html"),
      `<title>All Reviews</title><main>
        <h1>Store Reviews</h1>
        <p>Total reviews: 2</p>
        <table><tbody>
          <tr><td>Circe Fleece</td><td>Hannah</td><td><a href="detail1.html">Edit</a></td></tr>
          <tr><td>Olivia Jacket</td><td>Emma</td><td><a href="detail2.html">Edit</a></td></tr>
        </tbody></table>
      </main>`,
    );
    listUrl = pathToFileURL(join(dir, "list.html")).href;
  });

  afterEach(async () => {
    await cleanup();
  });

  test("webhand drilldown filters matching rows via Jev, visits detail pages, extracts checked radios, never reads passwords, and returns to list", async () => {
    deps.policy = () =>
      ({
        name: "stub",
        calls: [],
        config: () => ({}),
        async choose() {
          return new Decision("DONE");
        },
        async collect(_page: Page, _plan: Plan, _criterion: string, rows: { key: string; text: string }[]) {
          return new Set(rows.filter((r) => r.text.includes("Circe")).map((r) => r.key));
        },
      }) as unknown as Policy;

    const started = await cli("start", "--goal", "Check Circe reviews", "--url", listUrl, "--chrome", "linux");
    expect(started.code).toBe(OK);

    const drilled = await cli(
      "drilldown",
      "--match",
      "Circe Fleece",
      "--link-text",
      "Edit",
      "--fields",
      "Title,Rating",
      "--format",
      "json",
    );
    expect(drilled.code).toBe(OK);
    expect(drilled.out).not.toContain("SHOULD_NEVER_READ");
    expect(drilled.out).not.toContain("INLINE_JS_NOISE");
    const parsed = JSON.parse(drilled.out);
    expect(parsed.seen).toBe(2);
    expect(parsed.matched).toBe(1);
    expect(parsed.visited).toBe(1);
    expect(parsed.items[0].fields).toEqual({ Title: "Too tight", Rating: "2/3 (Rating_2)" });

    // Returned back to the list page cleanly.
    const obs = await cli("observe");
    expect(obs.out).toContain("list.html");
    await cli("finish", "--status", "done");
  });

  test("webhand query runs read-only one-shot with drilldown and auto-closes Chrome on GOAL_REPORTED", async () => {
    deps.policy = () =>
      ({
        name: "stub",
        calls: [],
        config: () => ({}),
        async choose() {
          return new Decision("DONE");
        },
        async verifyClaims(_p: Page, _pl: Plan, claims: string[]) {
          return new Map(claims.map((c) => [c, "MET" as const]));
        },
        async collect(_page: Page, _plan: Plan, _criterion: string, rows: { key: string; text: string }[]) {
          return new Set(rows.filter((r) => r.text.includes("Circe")).map((r) => r.key));
        },
      }) as unknown as Policy;

    const queried = await cli(
      "query",
      "--goal",
      "Get title and rating for Circe Fleece reviews",
      "--url",
      listUrl,
      "--expect",
      "Reviews table is shown",
      "--drilldown-match",
      "Circe Fleece",
      "--drilldown-link-text",
      "Edit",
      "--fields",
      "Title,Rating",
      "--chrome",
      "linux",
    );
    expect(queried.code).toBe(OK);
    expect(queried.out).toContain("Too tight");
    expect(queried.out).toContain("2/3 (Rating_2)");
    expect(queried.out).toContain("FINISHED status=done");
    expect(queried.out).not.toContain("ELEMENTS:");
    expect(session.load()).toBeNull(); // Session auto-closed cleanly!
  });

  test("webhand query supports --extract-kind, --answer-for block selection, and --auto-close on BLOCKED", async () => {
    deps.policy = () =>
      ({
        name: "stub",
        calls: [],
        config: () => ({}),
        async choose() {
          return new Decision("DONE");
        },
        async selectBlocks(_p: Page, _pl: Plan, _q: string, blocks: { key: string; text: string }[]) {
          return new Set(blocks.filter((b) => b.text.includes("Total reviews")).map((b) => b.key));
        },
      }) as unknown as Policy;

    const tableQ = await cli(
      "query",
      "--goal",
      "Read review table",
      "--url",
      listUrl,
      "--extract-kind",
      "table",
      "--format",
      "json",
      "--chrome",
      "linux",
    );
    expect(tableQ.code).toBe(OK);
    expect(tableQ.out).toContain("Circe Fleece");
    expect(tableQ.out).toContain("FINISHED status=done");
    expect(session.load()).toBeNull();

    const blockQ = await cli(
      "query",
      "--goal",
      "Count reviews",
      "--url",
      listUrl,
      "--answer-for",
      "total review count",
      "--chrome",
      "linux",
    );
    expect(blockQ.code).toBe(OK);
    expect(blockQ.out).toContain("QUERY ANSWER");
    expect(blockQ.out).toContain("Total reviews: 2");
    expect(session.load()).toBeNull();

    deps.policy = () =>
      ({
        name: "stub",
        calls: [],
        config: () => ({}),
        async choose() {
          return new Decision("BLOCKED");
        },
      }) as unknown as Policy;

    const blocked = await cli("query", "--goal", "Impossible", "--url", listUrl, "--auto-close", "--chrome", "linux");
    expect(blocked.code).not.toBe(OK);
    expect(blocked.out).toContain("OUTCOME BLOCKED");
    expect(blocked.out).toContain("FINISHED status=blocked");
    expect(session.load()).toBeNull();
  });
});
