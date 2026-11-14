import { afterEach, beforeEach, expect, test } from "vitest";
import { cli, readEvents, research, researchExit } from "./helpers.ts";
import { isolate, ScriptedJev } from "./jev.ts";

let log: string;
let cleanup: () => Promise<void>;

beforeEach(() => {
  ({ log, cleanup } = isolate());
});

afterEach(async () => {
  await cleanup();
});

const events = () => readEvents(log);

test("--compare scans the whole list before Jev acts; Jev is told the best; replan compares again or stops", async () => {
  const started = await research(
    "start",
    "--task",
    "plan_lowest",
    "--chrome",
    "linux",
    "--compare",
    "lowest monthly price",
  );
  expect(started.out).toContain("COMPARE: lowest monthly price");
  ScriptedJev.moves = [
    ["CLICK", "Choose Flax", null],
    ["DONE", null, null],
  ];
  const { out } = await cli("run");
  expect(out).toMatch(/COMPARED \(\d+ scrolls, reached the bottom\): Choose Flax — Flax 20 GB €12 Choose Flax/);
  const plan = ScriptedJev.plans[0] as { compared: { best: string } };
  expect(plan.compared.best).toMatch(/^Choose Flax/);
  expect((ScriptedJev.states[0] as { plan: { goal: string } }).plan.goal).toMatch(
    /^Act on the item found by comparing the whole list for "lowest monthly price": Choose Flax — /,
  );
  expect((ScriptedJev.states[0] as { plan: { compared: object } }).plan.compared).toMatchObject({ stopped: "bottom" });
  expect(events().filter((e) => e.type === "compare_round").length).toBeGreaterThan(1);
  expect(events().find((e) => e.type === "compare_end")).toMatchObject({
    best_label: "Choose Flax",
    stopped: "bottom",
  });
  expect(events().find((e) => e.type === "plan").compare).toBe("lowest monthly price");
  const finished = await research("finish", "--status", "done", "--reason", "Flax chosen");
  expect(finished.out).toContain("verified=true");
});

test("replan --compare none stops comparing; without it, the next attempt compares again", async () => {
  await research("start", "--task", "plan_lowest", "--chrome", "linux", "--compare", "lowest monthly price");
  ScriptedJev.moves = [["BLOCKED", null, null]];
  await cli("run");
  await cli("replan", "--reason", "Again");
  ScriptedJev.moves = [["BLOCKED", null, null]];
  expect((await cli("run")).out).toContain("COMPARED");
  const replanned = await cli("replan", "--reason", "No comparison", "--compare", "none");
  expect(replanned.out).not.toContain("COMPARE:");
  ScriptedJev.moves = [["BLOCKED", null, null]];
  expect((await cli("run")).out).not.toContain("COMPARED");
  expect(events().filter((e) => e.type === "compare_end")).toHaveLength(2);
});

test("--collect gathers every matching item, acts on nothing, and stops; the next run lets Jev act", async () => {
  const condition = "200 GB of storage and less than €40 a month";
  const started = await research(
    "start",
    "--task",
    "collect_more",
    "--chrome",
    "linux",
    "--collect",
    condition,
    "--step",
    "Type the Plan names value into the Plan names box",
    "--step",
    "Press Submit; done when Answer sent is shown",
  );
  expect(started.out).toContain(`COLLECT: ${condition}`);
  const { out, code } = await cli("run");
  expect(code).toBe(0);
  expect(out).toMatch(/COLLECTED \(\d+ scrolls, reached the bottom\): 4 of 40 items meet: 200 GB/);
  expect(out.match(/^- \S+ 200 GB €\d+$/gm)).toHaveLength(4);
  expect(out).toContain("Nothing was clicked or typed, and the page is back where it was.");
  expect(ScriptedJev.plans).toHaveLength(0);
  expect(events().find((e) => e.type === "collect_end")).toMatchObject({ matched: 4, seen: 40, stopped: "bottom" });
  expect(events().find((e) => e.type === "collect_end")).not.toHaveProperty("items");
  expect(out).toContain("run --value 'LABEL=VALUE'");
  ScriptedJev.moves = [
    ["TYPE_TEXT", "Plan names", "Plan names"],
    ["CLICK", "Submit", null],
    ["DONE", null, null],
  ];
  const names = out.match(/^- (\S+) 200 GB/gm)?.map((line) => line.split(" ")[1]) ?? [];
  const again = await cli("run", "--value", `Plan names=${names.join(", ")}`);
  expect(again.out).not.toContain("COLLECTED");
  expect(ScriptedJev.plans).toHaveLength(3);
  const goal = (ScriptedJev.states[0] as { plan: { goal: string } }).plan.goal;
  expect(goal).toMatch(/^1\. .*Values Claude wrote: Plan names: /);
  expect(goal).not.toContain("All plans table");
  const finished = await research("finish", "--status", "done", "--reason", "Names sent");
  expect(finished.out).toContain("verified=true");
});

test("--compare and --collect are not used together; replan --collect none stops collecting", async () => {
  expect(
    await researchExit("start", "--task", "collect_more", "--chrome", "linux", "--compare", "a", "--collect", "b"),
  ).toBe("Use --compare or --collect, not both");
  await research("start", "--task", "collect_more", "--chrome", "linux", "--collect", "less than €40");
  await cli("run");
  const both = await cli("replan", "--reason", "Both", "--compare", "cheapest");
  expect(both.out).toContain("REJECTED: use --compare or --collect, not both");
  await cli("replan", "--reason", "Again");
  expect((await cli("run")).out).toContain("COLLECTED");
  const off = await cli("replan", "--reason", "Enough", "--collect", "none");
  expect(off.out).not.toContain("COLLECT:");
  ScriptedJev.moves = [["BLOCKED", null, null]];
  expect((await cli("run")).out).not.toContain("COLLECTED");
});

test("--more lets a comparison go through every page; it needs --compare or --collect", async () => {
  expect(await researchExit("start", "--task", "plan_pages", "--chrome", "linux", "--more", "Next page")).toBe(
    "--more needs --compare or --collect",
  );
  const started = await research(
    "start",
    "--task",
    "plan_pages",
    "--chrome",
    "linux",
    "--compare",
    "lowest monthly price",
    "--more",
    "Next page",
  );
  expect(started.out).toContain("MORE: Next page");
  ScriptedJev.moves = [
    ["CLICK", "Choose Tuff", null],
    ["DONE", null, null],
  ];
  const { out } = await cli("run");
  expect(out).toMatch(/COMPARED \(\d+ scrolls, loaded more 3 times, reached the bottom\): Choose Tuff — /);
  expect(
    events()
      .filter((e) => e.type === "more")
      .map((e) => e.changed),
  ).toEqual(["page", "page", "page", undefined]);
  expect((await research("finish", "--status", "done", "--reason", "Tuff")).out).toContain("verified=true");
});

test("replan --more none stops pressing the control", async () => {
  await research("start", "--task", "plan_pages", "--chrome", "linux", "--compare", "lowest", "--more", "Next page");
  ScriptedJev.moves = [["BLOCKED", null, null]];
  await cli("run");
  const replanned = await cli("replan", "--reason", "One page", "--more", "none");
  expect(replanned.out).not.toContain("MORE:");
  ScriptedJev.moves = [["BLOCKED", null, null]];
  expect((await cli("run")).out).toMatch(/COMPARED \(\d+ scrolls, reached the bottom\)/);
});
