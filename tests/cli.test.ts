/** The role split across separate CLI calls, on real Chrome. Jev is replaced; no paid API. */

import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Browser } from "../src/browser.ts";
import * as cliModule from "../src/cli.ts";
import { actionSpace } from "../src/policies/base.ts";
import * as session from "../src/session.ts";
import { cli, readEvents, research, researchExit, tmpPath } from "./helpers.ts";
import { isolate, type Move, ScriptedJev } from "./jev.ts";

const { OK, FAILED, UNCERTAIN, BUDGET, UsageError } = cliModule;

let log: string;
let cleanup: () => Promise<void>;

beforeEach(() => {
  ({ log, cleanup } = isolate());
});

afterEach(async () => {
  await cleanup();
});

const events = () => readEvents(log);

async function begin(...options: string[]) {
  const { code } = await research(
    "start",
    "--task",
    "hotel_filter",
    "--chrome",
    "linux",
    "--step",
    "Search for Lisbon",
    "--step",
    "Open Casa Flora",
    "--value",
    "Destination=Lisbon",
    ...options,
  );
  expect(code).toBe(OK);
}

const FULL: Move[] = [
  ["TYPE_TEXT", "Destination", "Destination"],
  ["CLICK", "Find stays", null],
  ["SELECT", "Design", null],
  ["CLICK", "Free cancellation", null],
  ["CLICK", "View Casa Flora", null],
  ["DONE", null, null],
];

test("Jev runs to the goal in one call and verification passes", async () => {
  await begin();
  ScriptedJev.moves = [...FULL];
  const { code, out } = await cli("run");
  expect(code).toBe(OK);
  expect(out).toContain("OUTCOME GOAL_REPORTED (attempt 1/3)");
  const history = session.load()?.history;
  expect(history.slice(0, 2).map((s: Record<string, unknown>) => [s.operation, s.decided_by, s.text])).toEqual([
    ["TYPE_TEXT", "jev", "Lisbon"],
    ["CLICK", "jev", null],
  ]);
  await research("finish", "--status", "done");
  expect(session.load()).toBeNull();
  const end = events().at(-1);
  expect(end.verified).toBe(true);
  expect(end.escalations).toEqual({ GOAL_REPORTED: 1 });
  expect(end.decided_by).toEqual({ jev: 5 });
  expect(end.attempts).toBe(1);
  expect(end.providers.typesafe.calls).toBe(6);
  expect(end.handoffs).toBeGreaterThan(0);
  // The run log keeps what learning needs, without the typed text.
  const steps = events().filter((e) => e.type === "step");
  expect(steps[0]).toMatchObject({ value: "Destination", text_chars: 6 });
  expect("text" in steps[0]).toBe(false);
  expect(steps.every((s) => typeof s.region === "string")).toBe(true);
  expect(steps[0].url).toContain("scenario=%3Credacted%3E");
  const pages = events().filter((e) => e.type === "page");
  expect(pages.length).toBeGreaterThan(1);
  expect(pages[0].regions.some((r: Record<string, unknown>) => "shown_actions" in r)).toBe(true);
  expect(JSON.stringify(pages)).not.toContain("Lisbon");
  expect([end.service, end.runbook]).toEqual([null, null]);
  expect(end.handoff_chars).toBeGreaterThan(0);
});

test("Jev sees the goal, plan, page, and full history", async () => {
  await begin();
  ScriptedJev.moves = [
    ["CLICK", "Free cancellation", null],
    ["DONE", null, null],
  ];
  await cli("run");
  const state = ScriptedJev.states.at(-1) as {
    plan: { goal: string; steps: string[] };
    page: { url: string };
    action_history: { action: string }[];
  };
  expect(state.plan.goal.startsWith("Find a stay in Lisbon")).toBe(true);
  expect(state.plan.steps).toEqual(["1. Search for Lisbon", "2. Open Casa Flora"]);
  expect(state.page.url.endsWith("hotel.html?scenario=travel")).toBe(true);
  expect(state.action_history.map((h) => h.action)).toEqual(["Free cancellation"]);
});

test("a field without a fitting value returns to Claude", async () => {
  await begin();
  ScriptedJev.moves = [["TYPE_TEXT", "Destination", null]];
  const { out } = await cli("run");
  expect(out).toContain("OUTCOME NEEDS_VALUE");
  expect(out).not.toContain("ELEMENTS:"); // Value handoffs stay small.
  expect(session.load()?.history).toEqual([]);
  expect((await cli("run")).code).toBe(FAILED);
  ScriptedJev.moves = [
    ["TYPE_TEXT", "Destination", "City"],
    ["DONE", null, null],
  ];
  expect((await cli("run", "--value", "City=Porto")).code).toBe(OK);
  expect(session.load()?.history[0].text).toBe("Porto");
});

test("a person acts while nothing else does", async () => {
  await begin();
  ScriptedJev.moves = [["NEEDS_HUMAN", null, null]];
  expect((await cli("run")).out).toContain("OUTCOME NEEDS_HUMAN");
  expect((await cli("run")).code).toBe(FAILED);
  expect((await cli("act", "WAIT")).code).toBe(FAILED);
  ScriptedJev.moves = [["DONE", null, null]];
  expect((await cli("run", "--human-done")).code).toBe(OK);
  const last = ScriptedJev.states.at(-1) as { action_history: { kind: string }[] };
  expect(last.action_history.at(-1)?.kind).toBe("human");
  expect(
    events()
      .filter((e) => e.type === "human_step")
      .map((e) => e.status),
  ).toEqual(["requested", "done"]);
});

test("person steps need a visible window", async () => {
  expect(
    await researchExit("start", "--task", "hotel_filter", "--chrome", "linux", "--step", "[person] Sign in"),
  ).toMatch(/--headed/);
  expect(session.load()).toBeNull();
});

test("a stuck attempt is replanned from the start URL", async () => {
  await begin();
  const state = session.load() as session.State;
  state.history = [1, 2, 3].map((step) => ({
    step,
    attempt: 1,
    kind: "click",
    operation: "CLICK",
    action: "Find stays",
    text: null,
    url: "u",
    page_changed: false,
  }));
  session.save(state);
  await cli("run");
  expect(ScriptedJev.states).toEqual([]); // Stuck is detected before Jev is asked.
  expect(session.load()?.outcome).toBe("STUCK");
  expect((await cli("run")).code).toBe(FAILED);
  const replan = await cli("replan", "--reason", "Search did nothing; type first", "--restart");
  expect(replan.code).toBe(OK);
  expect(replan.out).toContain("ATTEMPT 2/3");
  ScriptedJev.moves = [...FULL];
  await cli("run");
  const plan = ScriptedJev.plans.at(-1);
  expect(plan?.attempt).toBe(2);
  expect(plan?.notes).toEqual(["Attempt 1 ended with STUCK. Claude: Search did nothing; type first"]);
  const first = ScriptedJev.states[0] as { action_history: { attempt: number }[] };
  expect(first.action_history[0].attempt).toBe(1); // Earlier attempts stay visible.
  await research("finish", "--status", "done");
  const end = events().at(-1);
  expect([end.verified, end.attempts]).toEqual([true, 2]);
  expect(end.attempt_outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(["STUCK", "GOAL_REPORTED"]);
});

test("replanning stops at the attempt limit", async () => {
  await begin("--max-attempts", "2");
  expect((await cli("replan", "--reason", "x")).code).toBe(OK);
  expect((await cli("replan", "--reason", "y")).code).toBe(BUDGET);
});

test("replan can replace steps and values", async () => {
  await begin();
  await cli("replan", "--reason", "x", "--step", "A different step", "--value", "Destination=Porto");
  const plan = session.load()?.plan;
  expect(plan.steps.map((s: { instruction: string }) => s.instruction)).toEqual(["A different step"]);
  expect(plan.values).toEqual([{ label: "Destination", value: "Porto" }]);
});

test("an uncertain action cannot be replanned", async () => {
  await begin();
  const state = session.load() as session.State;
  state.outcome = "UNCERTAIN";
  session.save(state);
  expect((await cli("replan", "--reason", "x")).code).toBe(UNCERTAIN);
  expect((await cli("run")).code).toBe(UNCERTAIN);
});

test("Claude's override lets Jev continue the attempt", async () => {
  await begin();
  ScriptedJev.moves = [["BLOCKED", null, null]];
  await cli("run");
  const [, targets] = actionSpace(session.load()?.page.actions);
  const index = [...(targets.get("CLICK") ?? [])].find(([, a]) => a.label.includes("Free cancellation"))?.[0];
  expect((await cli("act", "CLICK", index as string)).code).toBe(OK);
  const state = session.load() as session.State;
  expect(state.outcome).toBeNull();
  expect(state.history.map((s: Record<string, unknown>) => [s.decided_by, s.action])).toEqual([
    ["claude", "Free cancellation"],
  ]);
});

test("the attempt budget returns to Claude", async () => {
  await begin("--max-actions", "1");
  ScriptedJev.moves = [["CLICK", "Free cancellation", null]];
  expect((await cli("run")).out).toContain("OUTCOME ATTEMPT_BUDGET");
  expect((await cli("act", "WAIT")).code).toBe(BUDGET);
});

test("a claimed done does not pass verification", async () => {
  await research("start", "--task", "hotel_filter", "--chrome", "linux");
  await research("finish", "--status", "done");
  const end = events().at(-1);
  expect([end.status, end.verified]).toEqual(["done", false]);
});

test("an invalid override is rejected without a step", async () => {
  await begin();
  expect((await cli("act", "CLICK", "999")).code).toBe(FAILED);
  expect(session.load()?.history).toEqual([]);
});

test("a missing Jev key is reported before Chrome starts", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", undefined);
  expect(await researchExit("start", "--task", "hotel_filter", "--chrome", "linux")).toMatch(/TYPESAFE_API_KEY/);
  expect(session.load()).toBeNull();
});

test("a new session uses a temporary profile", async () => {
  await research("start", "--task", "hotel_filter", "--chrome", "linux");
  const state = session.load() as session.State;
  expect(basename(state.profile).startsWith("webhand-")).toBe(true);
  await research("finish", "--status", "abandoned");
  expect(existsSync(state.profile)).toBe(false);
});

test("a saved profile keeps its sign-in between runs", async () => {
  const page = join(tmpPath(), "site.html");
  writeFileSync(page, "<title>Site</title><h1>Site</h1>");
  const options = [
    "--goal",
    "Open the site",
    "--url",
    pathToFileURL(page).href,
    "--chrome",
    "linux",
    "--session",
    "profile:demo",
  ];
  await cli("start", ...options);
  let browser = await Browser.open(null, { port: session.load()?.port });
  await browser.context.addCookies([
    { name: "signed_in", value: "yes", url: "https://example.test/", expires: 2_000_000_000 },
  ]);
  await browser.close();
  const profile = session.load()?.profile;
  await research("finish", "--status", "abandoned");
  expect(existsSync(profile)).toBe(true);

  await cli("start", ...options);
  browser = await Browser.open(null, { port: session.load()?.port });
  const cookies = await browser.context.cookies("https://example.test/");
  await browser.close();
  expect(cookies.filter((c) => c.name === "signed_in").map((c) => c.value)).toEqual(["yes"]);
  expect(session.load()?.profile).toBe(profile);
});

test("a task keeps its own goal", async () => {
  expect(await researchExit("start", "--task", "hotel_filter", "--goal", "Something else")).toMatch(/own goal/);
  expect(await researchExit("start", "--task=hotel_filter", "--url=about:blank")).toMatch(/own goal/);
  expect(session.load()).toBeNull();
});

test("an unknown task stops before Chrome starts", async () => {
  expect(await researchExit("start", "--task", "no_such_task", "--chrome", "linux")).toMatch(/Unknown task/);
  expect(session.load()).toBeNull();
});

test("the shipped CLI has no --task", async () => {
  await expect(cli("start", "--task", "hotel_filter")).rejects.toThrow(UsageError);
  expect((await cli("start", "--help")).out).not.toContain("--task");
});

test("without a task, finish verifies nothing", async () => {
  await cli("start", "--goal", "Open the page", "--url", "about:blank", "--chrome", "linux");
  await cli("finish", "--status", "done");
  expect(events().find((e) => e.type === "run_start").task).toBeNull();
  expect([events().at(-1).verified, events().at(-1).evidence]).toEqual([null, "no verifier"]);
});

test("the research wrapper passes other commands through", async () => {
  await research("start", "--goal", "Open the page", "--url", "about:blank", "--chrome", "linux");
  expect((await research("observe")).out).toContain("about:blank");
  await research("finish", "--status", "abandoned");
  expect(events().at(-1).verified).toBeNull();
});

test("catalog lists learned services and procedures", async () => {
  const { code, out } = await cli("catalog", "--chrome", "linux");
  expect(code).toBe(OK);
  expect(out).toContain("SERVICE hotel-site");
  expect(out).toContain("PROCEDURE hotel-site/reserve [");
  expect(out).toContain("param check_in:");
  expect(out).toContain("SAVED PROFILES: (none)");
});

test("Claude chooses regions and Jev sees the outline", async () => {
  const started = await research(
    "start",
    "--task",
    "hotel_filter",
    "--chrome",
    "linux",
    "--step",
    "Search for Lisbon",
    "--step",
    "Open Casa Flora",
    "--value",
    "Destination=Lisbon",
    "--focus",
    "form",
    "--skip",
    "header",
  );
  expect(started.out).toContain("FOCUS: form");
  expect(started.out).toContain("SKIP: header");
  ScriptedJev.moves = [["BLOCKED", null, null]];
  const { out } = await cli("run");
  const state = ScriptedJev.states[0] as { page: { regions: { key: string; view?: string }[] } };
  const outline = Object.fromEntries(state.page.regions.map((region) => [region.key, region]));
  expect(outline["header/nav"].view).toBe("skip");
  expect(Object.values(outline).some((region) => region.view === "focus")).toBe(true);
  expect(out).toContain("REGIONS (shown/all");
  expect(events().find((e) => e.type === "run_start").view).toEqual({ focus: ["form"], skip: ["header"] });
});

test("replan replaces Claude's regions", async () => {
  await begin("--focus", "form");
  await cli("replan", "--reason", "The filter is in the header", "--focus", "header");
  const state = session.load() as session.State;
  expect(state.view).toEqual({ focus: ["header"], skip: [] });
  expect(state.page.regions.some((region: { view?: string }) => region.view === "focus")).toBe(true);
});

test("usage errors name the problem", () => {
  expect(() => cliModule.parse(["finish"])).toThrow(/--status/);
  expect(() => cliModule.parse(["finish", "--status", "maybe"])).toThrow(/invalid choice/);
  expect(() => cliModule.parse(["start", "--max-attempts", "x"])).toThrow(/invalid int/);
  expect(() => cliModule.parse(["nope"])).toThrow(cliModule.UsageError);
  const parsed = cliModule.parse(["start", "--step", "a", "--step=b", "--headed"]);
  expect("args" in parsed && parsed.args.step).toEqual(["a", "b"]);
  expect("args" in parsed && parsed.args.max_attempts).toBe(3);
});

test("with WEBHAND_SCREENSHOTS=1 the start page and each action are captured; stdout is unchanged", async () => {
  await begin();
  ScriptedJev.moves = [...FULL];
  const plain = (await cli("run")).out;
  await cli("finish", "--status", "done");
  expect(events().some((e) => e.type === "screenshot")).toBe(false);

  ({ log, cleanup } = isolate());
  vi.stubEnv("WEBHAND_SCREENSHOTS", "1");
  await begin();
  ScriptedJev.moves = [...FULL];
  expect((await cli("run")).out).toBe(plain);
  expect((await cli("replan", "--reason", "Check the restart", "--restart")).code).toBe(OK);
  const shots = events().filter((e) => e.type === "screenshot");
  expect(shots.map((e) => [e.step, e.attempt, e.after])).toEqual([
    [0, 1, "start"],
    [1, 1, "action"],
    [2, 1, "action"],
    [3, 1, "action"],
    [4, 1, "action"],
    [5, 1, "action"],
    [5, 2, "restart"],
  ]);
  expect(new Set(shots.map((e) => e.file)).size).toBe(shots.length);
  for (const shot of shots) expect(existsSync(join(log, "..", shot.file))).toBe(true);
});
