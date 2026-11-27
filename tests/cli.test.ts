/** The role split across separate CLI calls, on real Chrome. Jev is replaced; no paid API. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { UsageError } from "../src/args.ts";
import { Browser } from "../src/browser/index.ts";
import * as cliModule from "../src/cli.ts";
import { BUDGET, FAILED, OK, UNCERTAIN } from "../src/commands/context.ts";
import { logOnce } from "../src/core/metrics.ts";
import { probes } from "../src/engines/chrome.ts";
import { actionSpace } from "../src/policies/base.ts";
import * as runbook from "../src/storage/runbook/index.ts";
import * as session from "../src/storage/session.ts";
import { cli, cliExit, readEvents, research, researchExit, tmpPath } from "./helpers.ts";
import { isolate, type Move, ScriptedJev } from "./jev.ts";

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
  // The run log keeps what updating runbooks from a run needs, without the typed text.
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

test("two sessions run side by side, each with its own Chrome and state", async () => {
  await begin("--id", "a");
  const second = await research(
    "start",
    "--id",
    "b",
    "--task",
    "hotel_filter",
    "--chrome",
    "linux",
    "--step",
    "Search for Lisbon",
    "--value",
    "Destination=Lisbon",
  );
  expect(second.code).toBe(OK);
  expect(second.out).toContain("NEXT: webhand run --id b");
  const list = await cli("catalog", "--chrome", "linux");
  expect(list.out).toMatch(/ACTIVE SESSIONS[^\n]*\n {2}a: [^\n]*\n {2}b: /);
  // The default session was never started.
  expect(session.load()).toBeNull();
  session.use("a");
  const a = session.load();
  session.use("b");
  const b = session.load();
  expect(a?.port).not.toBe(b?.port);
  // Only a is run to the goal; b has not moved.
  ScriptedJev.moves = [...FULL];
  expect((await cli("run", "--id", "a")).out).toContain("OUTCOME GOAL_REPORTED");
  expect((await research("finish", "--id", "a", "--status", "done")).code).toBe(OK);
  expect(events().at(-1).verified).toBe(true);
  session.use("b");
  expect(session.load()).not.toBeNull();
  ScriptedJev.moves = [...FULL];
  expect((await cli("run", "--id", "b")).out).toContain("OUTCOME GOAL_REPORTED");
  expect((await research("finish", "--id", "b", "--status", "done")).code).toBe(OK);
  expect(events().at(-1).verified).toBe(true);
  session.use("b");
  expect(session.load()).toBeNull();
});

test("a session is used by one command at a time, and an id that is already open cannot start", async () => {
  await begin("--id", "a");
  await expect(begin("--id", "a")).rejects.toThrow();
  expect(await researchExit("start", "--id", "a", "--task", "hotel_filter", "--chrome", "linux")).toContain(
    "A session is active",
  );
  // A live process holding the lock: the parent of this test process.
  session.use("a");
  const lockFile = join(session.home(), "session-a.lock");
  writeFileSync(lockFile, String(process.ppid));
  expect(await cliExit("observe", "--id", "a")).toMatch(/Session "a" is busy/);
  // A lock left by a command that died is taken over.
  writeFileSync(lockFile, "999999999");
  expect((await cli("observe", "--id", "a")).code).toBe(OK);
  expect(existsSync(lockFile)).toBe(false);
  await research("finish", "--id", "a", "--status", "abandoned");
  expect(await cliExit("observe", "--id", "../x")).toContain("--id");
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

/** Runs the current attempt until Jev reports BLOCKED, so that the next replan starts a new one. */
async function blockedRun(): Promise<void> {
  ScriptedJev.moves = [["BLOCKED", null, null]];
  await cli("run");
}

test("replanning stops at the attempt limit", async () => {
  await begin("--max-attempts", "2");
  await blockedRun();
  expect((await cli("replan", "--reason", "x")).code).toBe(OK);
  await blockedRun();
  expect((await cli("replan", "--reason", "y")).code).toBe(BUDGET);
});

test("replan before anything ran revises the plan of the same attempt, even at the limit", async () => {
  await begin("--max-attempts", "1");
  const first = await cli("replan", "--reason", "The goal is now known", "--step", "A different step");
  expect(first.code).toBe(OK);
  expect(first.out).toContain("ATTEMPT 1/1");
  expect((await cli("replan", "--reason", "Once more", "--restart")).out).toContain("ATTEMPT 1/1");
  const state = session.load() as session.State;
  expect([state.plan.attempt, state.outcomes]).toEqual([1, []]);
  expect(state.plan.notes).toEqual([
    "Plan revised before attempt 1 ran. Claude: The goal is now known",
    "Plan revised before attempt 1 ran. Claude: Once more",
  ]);
  const plans = events().filter((e) => e.type === "plan");
  expect(plans.map((e) => [e.attempt, e.reason])).toEqual([
    [1, undefined],
    [1, "The goal is now known"],
    [1, "Once more"],
  ]);
  expect(events().some((e) => e.type === "attempt_end")).toBe(false);
  await blockedRun();
  expect((await cli("replan", "--reason", "y")).code).toBe(BUDGET);
});

test("a run that stops without an action uses its attempt; the new attempt is unused until it runs", async () => {
  await begin();
  await blockedRun();
  expect((await cli("replan", "--reason", "x")).out).toContain("ATTEMPT 2/3");
  expect((await cli("replan", "--reason", "y")).out).toContain("ATTEMPT 2/3");
  await blockedRun();
  expect((await cli("replan", "--reason", "z")).out).toContain("ATTEMPT 3/3");
});

test("an operation by act alone uses the attempt", async () => {
  await begin();
  expect((await cli("act", "SCROLL_DOWN")).code).toBe(OK);
  expect((await cli("replan", "--reason", "x")).out).toContain("ATTEMPT 2/3");
});

test("a session saved without the unused mark counts its attempt on replan", async () => {
  await begin();
  const state = session.load() as session.State;
  delete state.attempt_unused;
  session.save(state);
  expect((await cli("replan", "--reason", "x")).out).toContain("ATTEMPT 2/3");
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

test("act refuses what it cannot run, without a step", async () => {
  await begin();
  // A field needs text.
  const [, targets] = actionSpace(session.load()?.page.actions);
  const field = [...(targets.get("TYPE_TEXT") ?? [])].find(([, a]) => a.label.includes("Destination"))?.[0];
  const missing = await cli("act", "TYPE_TEXT", field as string);
  expect([missing.code, missing.out]).toEqual([FAILED, expect.stringContaining("TYPE_TEXT needs --text")]);
  // act runs one operation, not a verdict.
  const verdict = await cli("act", "DONE");
  expect([verdict.code, verdict.out]).toEqual([FAILED, expect.stringContaining("act runs one operation")]);
  // After an uncertain action nothing more runs.
  const state = session.load() as session.State;
  state.outcome = "UNCERTAIN";
  session.save(state);
  const uncertain = await cli("act", "WAIT");
  expect([uncertain.code, uncertain.out]).toEqual([
    UNCERTAIN,
    expect.stringContaining("the last action may have happened"),
  ]);
  expect(session.load()?.history).toEqual([]);
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

test("catalog lists known services and procedures", async () => {
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
  expect(() => cliModule.parse(["nope"])).toThrow(UsageError);
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

test("run_end counts executed actions only; refused and missing choices are counted apart", async () => {
  await begin();
  const state = session.load() as session.State;
  const entry = { attempt: 1, operation: "CLICK", action: "Find stays", text: null, url: "u", page_changed: true };
  state.history = [
    { step: 1, kind: "click", ...entry },
    { step: 2, kind: "stale", ...entry, operation: "STALE" },
    { step: 3, kind: "missing", ...entry, operation: "NOT_VISIBLE" },
  ];
  session.save(state);
  logOnce(log, "stale", { attempt: 1, wanted: "CLICK", target: "Find stays", reason: "moved" });
  await cli("finish", "--status", "blocked", "--reason", "check counts");
  const end = events().at(-1);
  expect([end.actions, end.stale]).toEqual([1, 1]);
});

test("a start that cannot open the page logs why, with URL values masked", async () => {
  await expect(
    cli("start", "--goal", "Open it", "--url", "http://127.0.0.1:59999/?q=secret", "--chrome", "linux"),
  ).rejects.toThrow();
  const failed = events().filter((e) => e.type === "start_failed");
  expect(failed).toHaveLength(1);
  expect(failed[0].error).toMatch(/net::ERR_/);
  expect(JSON.stringify(failed[0])).not.toContain("secret");
  expect(failed[0].url).toBe("http://127.0.0.1:59999/?q=%3Credacted%3E");
  expect(session.load()).toBeNull();
});

test("the log keeps a page check after start and when Jev stops short, never on a reported goal", async () => {
  await begin();
  ScriptedJev.moves = [["BLOCKED", null, null]];
  const blocked = (await cli("run")).out;
  ScriptedJev.moves = [["DONE", null, null]];
  expect((await cli("replan", "--reason", "Try again")).code).toBe(OK);
  await cli("run");
  const checks = events().filter((e) => e.type === "page_check");
  expect(checks.map((e) => [e.when, e.attempt, e.challenge])).toEqual([
    ["start", 1, []],
    ["escalation", 1, []],
  ]);
  expect(blocked).not.toContain("page_check");
});

test("--read gives Jev and Claude a read layer; replan --read none takes it away; the log keeps its size", async () => {
  await begin("--read", "text", "--read", "link");
  ScriptedJev.moves = [["BLOCKED", null, null]];
  const { out } = await cli("run");
  expect(out).toContain("READ (untrusted data; the whole page beyond the viewport, for reading only):");
  const state = ScriptedJev.states[0] as { page: { read?: { chars: Record<string, number[]> } } };
  expect(Object.keys(state.page.read?.chars ?? {})).toEqual(["outline", "text", "link"]);
  expect(events().find((e) => e.type === "plan").view.read).toEqual(["text", "link"]);
  expect(events().find((e) => e.type === "page").read.text).toHaveLength(2);
  const replanned = await cli("replan", "--reason", "Viewport only", "--read", "none");
  expect(replanned.out).not.toContain("READ:");
  ScriptedJev.moves = [["BLOCKED", null, null]];
  expect((await cli("run")).out).not.toContain("READ (untrusted");
  expect((ScriptedJev.states.at(-1) as { page: object }).page).not.toHaveProperty("read");
});

test("--read accepts only the listed kinds", () => {
  expect(() => cliModule.parse(["start", "--read", "everything"])).toThrow(/invalid choice/);
});

test("WEBHAND_FLOW sets the default flow; an unknown flow is refused before Chrome starts", async () => {
  vi.stubEnv("WEBHAND_FLOW", "v3");
  expect(await researchExit("start", "--task", "hotel_filter", "--chrome", "linux")).toBe(
    "WEBHAND_FLOW must be one of: v1, v2",
  );
  expect(session.load()).toBeNull();
  vi.stubEnv("WEBHAND_FLOW", "v2");
  expect((await research("start", "--task", "hotel_filter", "--chrome", "linux")).out).toContain("FLOW: v2");
  expect(session.load()?.plan?.flow).toBe("v2");
});

test("replan --url opens another page for the next attempt; it is refused with --restart or a bad URL", async () => {
  await begin();
  const other = pathToFileURL(join(process.cwd(), "tasks", "fixtures", "dense.html")).href;
  expect((await cli("replan", "--reason", "x", "--url", other, "--restart")).out).toContain(
    "REJECTED: use --url or --restart, not both",
  );
  expect((await cli("replan", "--reason", "x", "--url", "javascript:alert(1)")).out).toContain(
    "REJECTED: --url needs an http, https, or file URL, or a local file path",
  );
  expect((await cli("replan", "--reason", "x", "--url", "tasks/fixtures/no_such.html")).out).toContain(
    "REJECTED: --url file not found: tasks/fixtures/no_such.html",
  );
  expect(session.load()?.plan.attempt).toBe(1);
  await blockedRun();
  const replanned = await cli("replan", "--reason", "The start page moved; try the dense page", "--url", other);
  expect(replanned.code).toBe(OK);
  const state = session.load() as session.State;
  expect([state.plan.attempt, state.page?.url]).toEqual([2, other]);
  expect(events().find((e) => e.type === "plan" && e.attempt === 2)?.url).toBe(other);
  expect(
    (await cli("replan", "--reason", "Back by the catalog's path", "--url", "tasks/fixtures/dense.html")).code,
  ).toBe(OK);
  expect(session.load()?.page?.url).toBe(other);
});

test("replan --url gives the Windows Chrome a local file by its Windows path, as start does", async () => {
  await begin();
  const state = session.load() as session.State;
  session.save({ ...state, chrome: "windows" });
  vi.spyOn(probes, "toWindows").mockImplementation(
    (path: string) => `\\\\wsl.localhost\\Ubuntu${path.replaceAll("/", "\\")}`,
  );
  const opened = vi.spyOn(Browser, "open").mockRejectedValue(new Error("stop here"));
  await cli("replan", "--reason", "Another way in", "--url", "tasks/fixtures/dense.html").catch(() => {});
  expect(opened.mock.calls[0]?.[0]).toMatch(/^file:\/\/wsl\.localhost\/Ubuntu\/.+\/tasks\/fixtures\/dense\.html$/);
});

test("v2: ESCALATE stops with a diagnosis, and answer continues the same attempt", async () => {
  await begin("--flow", "v2");
  ScriptedJev.moves = [
    ["TYPE_TEXT", "Destination", "Destination"],
    ["ESCALATE", null, null],
    ["ESCALATE", null, null], // Asked again when the typed field made the page stale.
  ];
  const first = await cli("run");
  expect(first.code).toBe(OK);
  expect(first.out).toContain("OUTCOME ESCALATE (attempt 1/3)");
  expect(first.out).toContain("WHY: Jev handed the decision to Claude");
  expect(first.out).toContain("NEXT: answer --note");
  expect(session.load()?.outcome).toBe("ESCALATE");
  expect((await cli("run")).code).toBe(FAILED); // Not without an answer.

  ScriptedJev.moves = [["DONE", null, null]];
  const answered = await cli("answer", "--note", "Skip the cookie banner; search Lisbon");
  expect(answered.code).toBe(OK);
  expect(answered.out).toContain("OUTCOME GOAL_REPORTED (attempt 1/3)"); // The same attempt.
  const plan = ScriptedJev.plans.at(-1);
  expect(plan?.attempt).toBe(1);
  expect(plan?.instructions).toEqual(["Skip the cookie banner; search Lisbon"]);
  const seen = ScriptedJev.states.at(-1) as { plan: { claude_instructions: string[] }; action_history: unknown[] };
  expect(seen.plan.claude_instructions).toHaveLength(1);
  expect(seen.action_history.length).toBeGreaterThan(1); // The history was kept.
  const answer = events().find((e) => e.type === "answer");
  expect(answer.after).toBe("ESCALATE");
  expect(JSON.stringify(answer)).not.toContain("cookie"); // Claude's words are not logged, only their length.
});

test.each([
  ["sign_in", "a password field"],
  ["check", "a bot check or CAPTCHA widget"],
  ["dialog", "an open dialog"],
])("v2: GOAL_REPORTED on a page marked %s names the sign without claiming that it blocks", async (kind, sign) => {
  await begin("--flow", "v2");
  const state = session.load() as session.State;
  state.page = { ...state.page, status: { kind, unseen: { frames: 0, canvases: 0, objects: 0 } } };
  session.save(state);
  vi.spyOn(Browser.prototype, "fresh").mockResolvedValue(true); // Keep the marked page: no new observation.
  ScriptedJev.moves = [["DONE", null, null]];
  const { out } = await cli("run");
  expect(out).toContain("WHY: Jev thinks the goal is met and asks Claude to check the page");
  expect(out).toContain(`The page has ${sign}; check whether it blocks the goal`);
});

test("v2: GOAL_REPORTED on an error page still says it is an error page", async () => {
  await begin("--flow", "v2");
  const state = session.load() as session.State;
  state.page = { ...state.page, status: { kind: "error", unseen: { frames: 0, canvases: 0, objects: 0 } } };
  session.save(state);
  vi.spyOn(Browser.prototype, "fresh").mockResolvedValue(true);
  ScriptedJev.moves = [["DONE", null, null]];
  const { out } = await cli("run");
  expect(out).toContain("WHY: the page is an error page");
});

test.each([
  ["STUCK", [], "the last three actions did not change the page"],
  ["BLOCKED", [["BLOCKED", null, null]], "Jev handed the decision to Claude"],
  ["ESCALATE", [["ESCALATE", null, null]], "Jev handed the decision to Claude"],
])(
  "v2: %s on a page marked sign_in keeps its own diagnosis and names the password field",
  async (outcome, moves, why) => {
    await begin("--flow", "v2");
    const state = session.load() as session.State;
    if (outcome === "STUCK") {
      state.history = [1, 2, 3].map((step) => ({
        step,
        attempt: 1,
        kind: "click",
        operation: "CLICK",
        action: "CLICK",
        text: null,
        url: "u",
        page_changed: false,
      }));
    }
    state.page = { ...state.page, status: { kind: "sign_in", unseen: { frames: 0, canvases: 0, objects: 0 } } };
    session.save(state);
    vi.spyOn(Browser.prototype, "fresh").mockResolvedValue(true);
    ScriptedJev.moves = moves as typeof ScriptedJev.moves;
    const { out } = await cli("run");
    expect(out).toContain(`OUTCOME ${outcome}`);
    expect(out).toContain(`WHY: ${why}`);
    expect(out).toContain(". The page has a password field; check whether it blocks the goal");
    expect(out).not.toContain("a person must sign in");
  },
);

test("answer is for v2 only", async () => {
  await begin("--flow", "v1");
  ScriptedJev.moves = [["BLOCKED", null, null]];
  await cli("run");
  const { code, out } = await cli("answer", "--note", "x");
  expect(code).toBe(FAILED);
  expect(out).toContain("REJECTED: answer is for --flow v2");
});

test("v2: a STUCK run on a page with a canvas tells Claude the element may be inside it", async () => {
  await begin("--flow", "v2");
  const state = session.load() as session.State;
  state.history = [1, 2, 3].map((step) => ({
    step,
    attempt: 1,
    kind: "missing",
    operation: "NOT_VISIBLE",
    action: "Wanted to CLICK, but the needed element was not listed. Nothing ran",
    text: null,
    url: "u",
    page_changed: false,
  }));
  state.page = { ...state.page, status: { kind: "ready", unseen: { frames: 0, canvases: 2, objects: 0 } } };
  session.save(state);
  const { out } = await cli("run");
  expect(out).toContain("OUTCOME STUCK");
  expect(out).toContain("WHY: Jev could not find the element it needs");
  expect(out).toContain("2 canvas, 0 frame, and 0 plugin parts");
  expect(out).toContain("Answering cannot reveal it");
});

test("v2: a scroll loop is named in WHY", async () => {
  await begin("--flow", "v2");
  const state = session.load() as session.State;
  state.history = ["SCROLL_DOWN", "SCROLL_UP", "SCROLL_DOWN", "SCROLL_UP", "SCROLL_DOWN", "SCROLL_UP"].map(
    (operation, i) => ({
      step: i + 1,
      attempt: 1,
      kind: "scroll",
      operation,
      action: operation,
      text: null,
      url: "u",
      page_changed: true,
    }),
  );
  session.save(state);
  const { out } = await cli("run");
  expect(out).toContain("OUTCOME STUCK");
  expect(out).toContain("WHY: Jev scrolled up and down three times");
});

test("v2: BLOCKED on a page whose target is drawn on a canvas says so, and offers another way", async () => {
  expect((await research("start", "--task", "canvas_seats", "--chrome", "linux", "--flow", "v2")).code).toBe(OK);
  ScriptedJev.moves = [["BLOCKED", null, null]];
  const { out } = await cli("run");
  expect(out).toContain("OUTCOME BLOCKED");
  expect(out).toContain("1 canvas, 0 frame, and 0 plugin parts");
  expect(out).toContain("another way");
  await research("finish", "--status", "abandoned");
});

test("v2: BLOCKED on a page with nothing hidden gets no canvas hint", async () => {
  await begin("--flow", "v2");
  ScriptedJev.moves = [["BLOCKED", null, null]];
  const { out } = await cli("run");
  expect(out).toContain("OUTCOME BLOCKED");
  expect(out).not.toContain("plugin parts");
});

test("--run hands straight to Jev from start, replan, and act in one command", async () => {
  ScriptedJev.moves = [["BLOCKED", null, null]];
  const started = await research(
    "start",
    "--task",
    "hotel_filter",
    "--chrome",
    "linux",
    "--step",
    "Search for Lisbon",
    "--value",
    "Destination=Lisbon",
    "--run",
  );
  expect(started.code).toBe(OK);
  expect(started.out).toContain("OUTCOME BLOCKED (attempt 1/3)");
  expect(started.out).not.toContain("NEXT: webhand run");

  // act --run performs the override, skips intermediate page render, and hands straight back to Jev.
  const [, targets] = actionSpace(session.load()?.page.actions);
  const checkbox = [...(targets.get("CLICK") ?? [])].find(([, a]) => a.label.includes("Free cancellation"))?.[0];
  ScriptedJev.moves = [["BLOCKED", null, null]];
  const acted = await cli("act", "CLICK", checkbox as string, "--run");
  expect(acted.code).toBe(OK);
  expect(acted.out).toContain("OUTCOME BLOCKED (attempt 1/3)");
  expect(acted.out).toContain('CLICK "Free cancellation"');

  // replan --run starts the next attempt and hands straight to Jev without an extra round trip.
  ScriptedJev.moves = [...FULL];
  const replanned = await cli("replan", "--reason", "Run the full plan", "--restart", "--run");
  expect(replanned.code).toBe(OK);
  expect(replanned.out).toContain("OUTCOME GOAL_REPORTED (attempt 2/3)");
  expect(replanned.out).not.toContain("NEXT: webhand run");

  await research("finish", "--status", "done");
  const end = events().at(-1);
  expect(end.verified).toBe(true);
  expect(end.attempts).toBe(2);
});

/** A user-scope service for the test, with the extra TOML lines given. */
function saveService(name: string, extra: string, tail = ""): void {
  const file = runbook.servicePath(name, "user");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `service = "${name}"\ndescription = "d"\nbase_url = "x"\nfacts = ["A fact"]\n${extra}\n[login]\nrequired = false\n${tail}`,
  );
}

test("replan adds service information to a session started without one", async () => {
  saveService(
    "added",
    "",
    '[[pages]]\nurl = "x"\npurpose = "p"\n[[pages.regions]]\nkey = "footer"\ndefault = "skip"\n',
  );
  saveService("elsewhere", 'allowed_domains = ["shop.test"]');
  await begin();
  const state = () => session.load() as session.State;
  const replan = (service: string) => cli("replan", "--reason", "Use the saved facts", "--service", service);

  expect((await replan("no-such-service")).out).toContain("REJECTED: no service information");
  expect((await replan("elsewhere")).out).toContain("outside service elsewhere's allowed_domains");
  expect(state().service).toBeNull();

  expect((await replan("added")).code).toBe(OK);
  expect(state().service).toBe("added");
  expect(state().plan.service?.facts).toEqual(["A fact"]);
  expect(state().view?.skip).toContain("footer");
  expect(events().findLast((e) => e.type === "plan")?.service).toBe("added");

  // The same service again is fine; another one is not.
  expect((await replan("added")).code).toBe(OK);
  expect((await replan("hotel")).out).toContain("already uses service added");
});
