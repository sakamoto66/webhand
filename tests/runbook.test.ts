/** Runbook loading, scopes, and their place in the role split. Jev is replaced; no paid API. */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { deps } from "../src/cli.ts";
import * as runbook from "../src/runbook.ts";
import * as session from "../src/session.ts";
import { cli, cliExit, inDirectory, readEvents, research, researchExit, tmpPath } from "./helpers.ts";
import { isolate, ScriptedJev } from "./jev.ts";

const HUMAN = `
service = "demo"
name = "login"
goal = "Open {section}"
start_url = "{url}"
status = "approved"
sources = ["code:test"]

[params.section]
description = "Section"

[params.url]
description = "Start"

[[steps]]
actor = "human"
instruction = "Log in"
done_when = "The account name is shown"

[[steps]]
instruction = "Open {section}"
hints = ["Use the top menu"]
`;

let log: string;
let cleanup: () => Promise<void>;

beforeEach(() => {
  ({ log, cleanup } = isolate());
});

afterEach(async () => {
  await cleanup();
});

/** A runbook file outside any scope, loaded straight from its path. */
function book(text: string) {
  const file = join(tmpPath(), "demo.toml");
  writeFileSync(file, text);
  return (values: Record<string, string>) => runbook.loadFile(file, "demo", "project", values);
}

/** A runbook in the user's scope, as `learn --scope user` would leave it. */
function userBook(name: string, text: string): string {
  const file = runbook.path(name, "user");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

const values = (url = "about:blank") => ({ section: "Reports", url });

test("parameters are filled everywhere", () => {
  const loaded = book(HUMAN)(values());
  expect(loaded.goal).toBe("Open Reports");
  expect(loaded.steps[1].instruction).toBe("Open Reports");
  expect(loaded.steps[0].actor).toBe("human");
});

test("a missing parameter is an error", () => {
  expect(() => book(HUMAN)({ url: "about:blank" })).toThrow(/section/);
});

test("an unknown parameter is an error", () => {
  expect(() => book(HUMAN)({ ...values(), typo: "x" })).toThrow(/unknown parameters \["typo"\]/);
});

test("a parameter value is not expanded again", () => {
  expect(book(HUMAN)({ section: "{url}", url: "about:blank" }).goal).toBe("Open {url}");
});

test("an unknown actor is an error", () => {
  expect(() => book(HUMAN.replace('actor = "human"', 'actor = "robot"'))(values())).toThrow(/robot/);
});

test.each(["../secret", "a/b/c", "", "a b"])("name %j stays inside the runbook folder", (name) => {
  expect(() => runbook.path(name)).toThrow(runbook.RunbookError);
});

test("Japanese names are names", () => {
  expect(runbook.path("予約/検索", "user")).toBe(join(runbook.root("user"), "予約", "検索.toml"));
});

const HOTEL = ["--param", "city=Lisbon", "--param", "category=Design", "--param", "stay=Casa Flora"];

test("a relative start_url is a file under the project", async () => {
  await cli("start", "--runbook", "hotel/filter", "--allow-draft", "--chrome", "linux", ...HOTEL);
  const state = session.load();
  expect(state?.page.title).toContain("Forma");
  expect(state?.page.url).toMatch(/tasks\/fixtures\/hotel\.html\?scenario=travel$/);
  expect(state?.runbook.scope).toBe("project");
});

test("a missing local start_url is an error", () => {
  expect(() => runbook.resolveUrl("tasks/fixtures/missing.html")).toThrow(/not found/);
});

test("a draft needs explicit permission", async () => {
  expect(await researchExit("start", "--task", "hotel_filter", "--runbook", "hotel/filter", ...HOTEL)).toMatch(/draft/);
  expect(session.load()).toBeNull();
});

test("Jev gets the runbook plan, service facts, and params as values", async () => {
  await research(
    "start",
    "--task",
    "hotel_filter",
    "--runbook",
    "hotel/filter",
    "--allow-draft",
    "--chrome",
    "linux",
    ...HOTEL,
  );
  ScriptedJev.moves = [["DONE", null, null]];
  await cli("run");
  const state = ScriptedJev.states[0] as { plan: { steps: string[] }; service: { facts: string[] } };
  expect(state.plan.steps[0].startsWith("1. Enter Lisbon as the Destination")).toBe(true);
  expect(state.plan.steps[0]).toContain("places in Lisbon");
  expect(state.service.facts.some((fact) => fact.includes("not applied until Find stays"))).toBe(true);
  expect(ScriptedJev.plans[0].values).toContainEqual({ label: "city", value: "Lisbon" });
  const events = readEvents(log);
  expect(events.find((e) => e.type === "run_start").runbook.name).toBe("hotel/filter");
  expect(events.find((e) => e.type === "plan").source).toBe("runbook");
});

test("steps from Claude replace the runbook steps", async () => {
  await research(
    "start",
    "--task",
    "hotel_filter",
    "--runbook",
    "hotel/filter",
    "--allow-draft",
    "--chrome",
    "linux",
    "--step",
    "Search for Lisbon",
    ...HOTEL,
  );
  expect(session.load()?.plan.steps.map((s: { instruction: string }) => s.instruction)).toEqual(["Search for Lisbon"]);
});

test("human steps need a visible window", async () => {
  userBook("demo", HUMAN);
  expect(await cliExit("start", "--runbook", "demo", "--param", "section=A", "--param", "url=about:blank")).toMatch(
    /--headed/,
  );
  expect(session.load()).toBeNull();
});

test("person steps are marked in Jev state", async () => {
  deps.startChrome = (options) => session.startChrome({ ...options, headed: false });
  const page = join(tmpPath(), "page.html");
  writeFileSync(page, "<h1>Home</h1><button>Reports</button>");
  userBook("demo", HUMAN);
  await cli(
    "start",
    "--runbook",
    "demo",
    "--headed",
    "--chrome",
    "linux",
    "--param",
    "section=Reports",
    "--param",
    `url=${pathToFileURL(page).href}`,
  );
  ScriptedJev.moves = [["NEEDS_HUMAN", null, null]];
  await cli("run");
  const state = ScriptedJev.states[0] as { plan: { steps: string[] } };
  expect(state.plan.steps[0].startsWith("1. [person] Log in")).toBe(true);
});

const SERVICE = `
service = "demo"
description = "A demo service"
base_url = "https://demo.test/"
sources = ["code:test"]
facts = ["Reports live under the top menu"]

[login]
required = true
url = "https://demo.test/login"
`;

/** A folder outside the repository, so only the scopes the test makes are read. */
function elsewhere<T>(fn: () => T | Promise<T>): Promise<T> {
  return inDirectory(realpathSync(tmpPath()), fn);
}

function userFile(relative: string, text: string): void {
  const file = join(runbook.root("user"), relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test("service information and catalog", async () => {
  await elsewhere(() => {
    userFile("demo/service.toml", SERVICE);
    userFile("demo/login.toml", HUMAN);
    const info = runbook.loadService("demo");
    expect(info?.login).toEqual({ required: true, url: "https://demo.test/login" });
    expect(info?.facts).toEqual(["Reports live under the top menu"]);
    const entries = runbook.catalog();
    expect(entries).toHaveLength(1);
    expect(entries[0].procedures.map((p) => p.name)).toEqual(["demo/login"]);
    expect(entries[0].procedures[0].human_steps).toBe(1);
    expect(runbook.loadService("missing")).toBeNull();
  });
});

test("service is not a procedure name", () => {
  expect(() => runbook.path("hotel/service")).toThrow(runbook.RunbookError);
});

const REGION_SERVICE = `${SERVICE}
[[pages]]
url = "https://demo.test/reports"
purpose = "Reports"

[[pages.regions]]
key = "main/form:Filter"
purpose = "The report filter"

[[pages.regions]]
key = "footer"
purpose = "Site links"
default = "skip"
`;

test("regions and their defaults are learned", async () => {
  await elsewhere(() => {
    userFile("demo/service.toml", REGION_SERVICE);
    const info = runbook.loadService("demo");
    expect(info?.pages[0].regions[1]).toEqual({ key: "footer", purpose: "Site links", default: "skip" });
    expect(runbook.serviceView(info)).toEqual({ focus: [], skip: ["footer"] });
  });
});

test("an unknown region default is an error", async () => {
  await elsewhere(() => {
    userFile("demo/service.toml", REGION_SERVICE.replace('"skip"', '"hide"'));
    expect(() => runbook.loadService("demo")).toThrow(/hide/);
  });
});

test("a runbook names regions to focus on and skip", () => {
  const loaded = book(`focus = ["form:Filter"]\nskip = ["nav"]\n${HUMAN}`)(values());
  expect([loaded.focus, loaded.skip]).toEqual([["form:Filter"], ["nav"]]);
});

test("region patterns must be a list of keys", () => {
  expect(() => book(`focus = "form"\n${HUMAN}`)(values())).toThrow(/focus/);
});

test("a later layer of region choices wins", () => {
  const learned = { focus: ["main"], skip: ["footer", "nav"] };
  const claude = { focus: ["nav", "form"], skip: ["main"] };
  expect(runbook.view(learned, null, claude)).toEqual({ focus: ["nav", "form"], skip: ["footer", "main"] });
});

// --- Scopes ----------------------------------------------------------------------------------

test("a project runbook wins over a user runbook of the same name, and both are listed", async () => {
  const project = realpathSync(tmpPath());
  mkdirSync(join(project, ".webhand", "runbooks", "demo"), { recursive: true });
  await inDirectory(project, () => {
    writeFileSync(join(project, ".webhand", "runbooks", "demo", "login.toml"), HUMAN.replace("Open {section}", "P"));
    userFile("demo/login.toml", HUMAN.replace("Open {section}", "U"));
    userFile("demo/other.toml", HUMAN);
    userFile("demo/service.toml", SERVICE);
    expect(runbook.load("demo/login", values()).goal).toBe("P");
    expect(runbook.load("demo/login", values()).scope).toBe("project");
    expect(runbook.load("demo/other", values()).scope).toBe("user");
    const [entry] = runbook.catalog();
    expect(entry.info?.scope).toBe("user");
    expect(entry.procedures.map((p) => [p.name, p.scope])).toEqual([
      ["demo/login", "project"],
      ["demo/other", "user"],
    ]);
  });
});

test("a relative start_url in the user scope is a file next to the user folder", async () => {
  await elsewhere(() => {
    const home = process.env.WEBHAND_HOME as string;
    writeFileSync(join(dirname(home), "page.html"), "<h1>x</h1>");
    userFile("demo/login.toml", HUMAN);
    const loaded = runbook.load("demo/login", { section: "A", url: "page.html" });
    expect(loaded.start_url).toBe(pathToFileURL(join(dirname(home), "page.html")).href);
  });
});

test("catalog prints both runbook folders and the scope of each procedure", async () => {
  const { out } = await cli("catalog", "--chrome", "linux");
  const lines = out.split("\n");
  expect(lines[0]).toBe(`RUNBOOKS (project) ${join(process.cwd(), ".webhand", "runbooks")}`);
  expect(lines[1]).toBe(`RUNBOOKS (user) ${runbook.root("user")}`);
  expect(out).toContain("SERVICE hotel (project)");
  expect(out).toContain("PROCEDURE hotel/filter [draft] (project):");
});
