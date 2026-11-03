/** Recording a demonstration on real Chrome, with trusted input as a person would produce it. */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page as PlaywrightPage } from "playwright-core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Browser } from "../src/browser.ts";
import * as learn from "../src/learn.ts";
import { Recorder } from "../src/metrics.ts";
import * as session from "../src/session.ts";
import { readEvents, tmpPath } from "./helpers.ts";

const SECRET = "hunter2-do-not-keep";
const FORM = `<title>Sign in</title><h1>Sign in</h1>
<form action="next.html"><label>City <input name="city"></label>
<label>Password <input type="password" name="pw"></label>
<label>Reference <input name="ref" autocomplete="one-time-code"></label>
<label><input type="checkbox" name="keep"> Keep me</label>
<select aria-label="Plan" name="plan"><option>Basic</option><option>Pro</option></select>
<button>Continue</button></form>`;

type Move = (page: PlaywrightPage) => Promise<unknown>;

let dir: string;
let chrome: session.State;
let browser: Browser;
let log: string;
let recorder: Recorder;

beforeEach(async () => {
  dir = tmpPath();
  writeFileSync(join(dir, "form.html"), FORM);
  writeFileSync(join(dir, "next.html"), "<title>Done</title><h1>Welcome</h1><a href='form.html'>Back</a>");
  chrome = await session.startChrome();
  browser = await Browser.open(null, { port: chrome.port });
  log = join(dir, "learn.jsonl");
  recorder = new Recorder(log);
});

afterEach(async () => {
  recorder.close();
  await browser.close();
  await session.stopChrome(chrome);
});

async function play(moves: Move[]) {
  const queue = [...moves];
  const until = async () => {
    const move = queue.shift();
    if (move) {
      await move(browser.page);
      await browser.page.waitForTimeout(50);
      return false;
    }
    await browser.page.waitForTimeout(600);
    return true;
  };
  return learn.record(browser, pathToFileURL(join(dir, "form.html")).href, recorder, until);
}

async function fillForm(page: PlaywrightPage) {
  await page.getByLabel("City").click();
  await page.keyboard.type("Lisbon");
  await page.getByLabel("Password").click();
  await page.keyboard.type(SECRET);
  await page.getByLabel("Reference").click();
  await page.keyboard.type(SECRET);
  await page.getByLabel("Keep me").click();
}

async function choosePlan(page: PlaywrightPage) {
  await page.getByLabel("Plan").focus(); // selectOption() fires untrusted events, unlike a person.
  await page.keyboard.press("ArrowDown");
}

const MOVES: Move[] = [fillForm, choosePlan, (p) => p.getByRole("button").click()];

function actions() {
  const events = readEvents(log);
  return { steps: events.filter((e) => e.type === "action"), events };
}

test("actions use the names the agent sees", async () => {
  await play(MOVES);
  const { steps } = actions();
  const seen = steps.map((s) => [s.operation, s.label]);
  expect(seen).toContainEqual(["fill", "City"]);
  expect(seen).toContainEqual(["toggle", "Keep me"]);
  expect(seen).toContainEqual(["select", "Plan"]);
  expect(seen).toContainEqual(["click", "Continue"]);
  expect(steps.find((s) => s.label === "City").value).toBe("Lisbon");
});

test("secrets never reach the record", async () => {
  await play(MOVES);
  expect(readFileSync(log, "utf8")).not.toContain(SECRET);
  const { steps } = actions();
  expect(steps.filter((s) => ["Password", "Reference"].includes(s.label)).map((s) => s.value)).toEqual([
    "<redacted>",
    "<redacted>",
  ]);
});

test("secrets in a GET form URL are masked", async () => {
  await play(MOVES);
  const pages = actions().events.filter((e) => e.type === "page" && e.title === "Done");
  expect(pages.length, "recording continues after navigation").toBeGreaterThan(0);
  expect(pages[0].url).toContain("pw=%3Credacted%3E");
});

test("forged events are ignored", async () => {
  await play([(p) => p.evaluate("document.querySelector('button').click()")]);
  expect(actions().steps.some((s) => s.label === "Continue")).toBe(false);
});

const SHADOW = `<title>Shadow</title><div id="host"></div><script>
const root=document.getElementById('host').attachShadow({mode:'open'});
root.innerHTML='<form action="next.html"><label>City <input name="city"></label>'+
  '<label><input type="checkbox" name="keep"> Keep me</label><button>Continue</button></form>';
</script>`;

test("changes inside open shadow DOM are recorded", async () => {
  writeFileSync(join(dir, "form.html"), SHADOW);
  await play([
    async (page) => {
      await page.getByLabel("City").click();
      await page.keyboard.type("Lisbon");
      await page.getByLabel("Keep me").click();
    },
    (p) => p.getByRole("button").click(),
  ]);
  const { steps } = actions();
  const seen = steps.map((s) => [s.operation, s.label, s.value ?? null]);
  expect(seen).toContainEqual(["fill", "City", "Lisbon"]);
  expect(seen).toContainEqual(["toggle", "Keep me", null]);
  expect(steps.some((s) => s.operation === "submit")).toBe(true);
});

const REGIONS = `<title>Regions</title><nav aria-label="Top"><a href="#x">Home</a></nav>
<main><form aria-label="Card number"><label>City <input name="city"></label><button>Go</button></form></main>`;

test("actions and pages carry regions without secret names", async () => {
  writeFileSync(join(dir, "form.html"), REGIONS);
  await play([
    async (page) => {
      await page.getByLabel("City").click();
      await page.keyboard.type("Lisbon");
      await page.getByLabel("City").press("Tab");
    },
  ]);
  const { steps, events } = actions();
  expect(steps.find((s) => s.label === "City").region).toBe("main/form:<redacted>");
  const outline = events.find((e) => e.type === "page").regions;
  const keys = new Set(outline.map((r: { key: string }) => r.key));
  expect(keys.has("nav:Top") && keys.has("main/form:<redacted>")).toBe(true);
  expect(Object.keys(outline[0]).every((key) => key in learn.REGION_FIELDS)).toBe(true);
  expect(readFileSync(log, "utf8")).not.toContain("Card number");
});

test("a forged outline keeps only typed fields", () => {
  expect(learn.outline("x")).toEqual([]);
  expect(learn.outline([{ key: "nav", actions: "9", extra: 1 }, 3])).toEqual([{ key: "nav" }]);
});
