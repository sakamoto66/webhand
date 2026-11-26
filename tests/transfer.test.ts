/** Uploads and downloads in real headless Chrome on a local server. No model calls. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Browser } from "../src/browser/index.ts";
import { CliExit } from "../src/commands/context.ts";
import { parseFiles } from "../src/commands/shared.ts";
import { toJson } from "../src/core/format.ts";
import { type Action, type Page, PolicyError, StalePage } from "../src/core/types.ts";
import { describePlan, recentActions } from "../src/output.ts";
import { actionSpace, fileChoices, modelState } from "../src/policies/base.ts";
import { JevPolicy } from "../src/policies/jev.ts";
import { buildQuestions } from "../src/policies/jev-questions.ts";
import { tmpPath } from "./helpers.ts";

const PAGE = `<!doctype html><title>t</title>
<label>Resume <input type="file" id="cv"></label>
<p id="out">none</p>
<a href="/report.csv">Download report</a>
<script>document.getElementById('cv').addEventListener('change', e =>
  document.getElementById('out').textContent = e.target.files[0].name)</script>`;

// File inputs the page hides. D has no visible trigger (a closed dialog); E has two buttons, so it is ambiguous.
const HIDDEN = `<!doctype html><title>h</title>
<label for="a">Attach CV</label><input type="file" id="a" style="display:none">
<div><button type="button">Choose photo</button><input type="file" id="b" hidden></div>
<div style="position:relative;width:120px;height:30px"><button type="button">Overlay</button>
<input type="file" id="c" style="opacity:0;position:absolute;inset:0"></div>
<div style="display:none"><input type="file" id="d"></div>
<div><button type="button">One</button><button type="button">Two</button><input type="file" id="e" hidden></div>
<p id="out"></p>
<script>for (const i of document.querySelectorAll('input[type=file]'))
  i.addEventListener('change', e => document.getElementById('out').textContent += i.id + ':' + e.target.files[0].name + ';')</script>`;

let server: Server;
let url: string;
let browser: Browser | null = null;

beforeEach(async () => {
  server = createServer((req, res) => {
    if (req.url === "/report.csv") {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"' });
      res.end("a,b\n1,2\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/hidden" ? HIDDEN : PAGE);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterEach(async () => {
  await browser?.close();
  browser = null;
  await new Promise((done) => server.close(done));
});

const find = (page: Page, test: (a: Action) => boolean) => page.actions.find(test) as Action;

test("a file input is offered as an upload and its value is never read", async () => {
  browser = await Browser.open(url);
  const page = await browser.observe();
  const upload = find(page, (a) => a.kind === "upload");
  expect(upload.label).toBe("Resume");
  expect("value" in upload).toBe(false);
});

test("an upload gives the input the file and the page sees the change", async () => {
  const file = join(tmpPath(), "cv.txt");
  writeFileSync(file, "hello");
  browser = await Browser.open(url);
  const page = await browser.observe();
  await browser.act(
    find(page, (a) => a.kind === "upload"),
    page,
    file,
  );
  expect(await browser.evaluate("document.getElementById('out').textContent")).toBe("cv.txt");
});

test("an upload without a file runs nothing", async () => {
  browser = await Browser.open(url);
  const page = await browser.observe();
  await expect(
    browser.act(
      find(page, (a) => a.kind === "upload"),
      page,
      null,
    ),
  ).rejects.toThrow(PolicyError);
});

test("a download lands in the download directory and is reported once", async () => {
  const dir = join(tmpPath(), "downloads");
  browser = await Browser.open(url, { downloadDir: dir });
  const page = await browser.observe();
  await browser.act(
    find(page, (a) => a.label === "Download report"),
    page,
  );
  const files = browser.takeDownloads();
  expect(files).toEqual([{ name: "report.csv", bytes: 8 }]);
  expect(readFileSync(join(dir, "report.csv"), "utf8")).toBe("a,b\n1,2\n");
  expect(browser.takeDownloads()).toEqual([]);
});

test("without a download directory nothing is reported", async () => {
  browser = await Browser.open(url);
  const page = await browser.observe();
  await browser.act(
    find(page, (a) => a.label === "Download report"),
    page,
  );
  expect(browser.takeDownloads()).toEqual([]);
});

test("Jev is asked which file by label, never by path", async () => {
  browser = await Browser.open(url);
  const page = await browser.observe();
  const plan = { goal: "g", steps: [], values: [], files: [{ label: "my resume", value: "/home/x/secret/cv.pdf" }] };
  const [, targets, controls] = actionSpace(page.actions);
  const [questions] = buildQuestions(plan, targets, controls, new Map(), false, false, fileChoices(plan));
  const asked = toJson(questions);
  expect(asked).toContain("my resume");
  expect(asked).not.toContain("/home/x/secret");
  expect(questions).toHaveProperty("upload_file_file");
});

const uploaded = (value: string) => ({
  step: 1,
  attempt: 1,
  kind: "upload",
  operation: "UPLOAD_FILE",
  action: "Resume",
  text: value,
  url: "u",
  page_changed: true,
});

test("no request to Jev holds the path of an uploaded file", async () => {
  browser = await Browser.open(url);
  const page = await browser.observe();
  const path = "/home/x/secret/cv.pdf";
  const plan = { goal: "g", steps: [], values: [], files: [{ label: "my resume", value: path }], attempt: 1 };
  const sent: string[] = [];
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const policy = new JevPolicy({
    fetch: async (_url, init) => {
      sent.push(init.body);
      return { status: 400, json: async () => ({}) };
    },
  });
  await expect(policy.choose(page, plan, [uploaded(path)])).rejects.toThrow(PolicyError);
  vi.unstubAllEnvs();
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toContain("/home/x/secret");
  expect((modelState(page, [uploaded(path)], plan).action_history as { text: unknown }[])[0].text).toBe("my resume");
});

test("an uploaded file the plan no longer names is sent to Jev as no text", async () => {
  browser = await Browser.open(url);
  const page = await browser.observe();
  const replaced = { goal: "g", steps: [], values: [], files: [{ label: "my resume", value: "/home/x/new.pdf" }] };
  for (const plan of [replaced, null]) {
    const state = modelState(page, [uploaded("/home/x/secret/cv.pdf")], plan);
    expect((state.action_history as { text: unknown }[])[0].text).toBeNull();
  }
});

test("only a file under the current directory can be given, and never a secret", () => {
  const dir = tmpPath();
  writeFileSync(join(dir, "cv.txt"), "x");
  writeFileSync(join(dir, ".env"), "KEY=1");
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  expect(parseFiles(["cv=cv.txt"])).toEqual([{ label: "cv", value: expect.stringMatching(/cv\.txt$/) }]);
  expect(() => parseFiles(["x=.env"])).toThrow(CliExit);
  expect(() => parseFiles(["x=/etc/hostname"])).toThrow(CliExit);
  expect(() => parseFiles(["x=missing.txt"])).toThrow(CliExit);
  expect(() => parseFiles(["no-equals"])).toThrow(CliExit);
  expect(existsSync(join(dir, "cv.txt"))).toBe(true);
  vi.restoreAllMocks();
});

test("a run's action list says what a click downloaded, and the plan names its files by label", () => {
  const history = [
    {
      step: 1,
      attempt: 1,
      kind: "click",
      operation: "CLICK",
      action: "Download report",
      page_changed: false,
      text: null,
    },
  ];
  const downloads = [{ name: "report.csv", bytes: 8 }];
  const state = { plan: { attempt: 1 }, history: [{ ...history[0], downloads }] };
  expect(recentActions(state)).toContain('CLICK "Download report" (page unchanged) DOWNLOADED: report.csv (8 bytes)');
  expect(recentActions({ plan: { attempt: 1 }, history })).not.toContain("DOWNLOADED");
  const plan = { goal: "g", steps: [], values: [], files: [{ label: "Resume", value: "/secret/cv.pdf" }] };
  expect(describePlan(plan)).toContain("FILES: Resume");
  expect(describePlan(plan)).not.toContain("/secret");
});

test("a file input the page hides is offered through its visible trigger and given its file", async () => {
  const file = join(tmpPath(), "cv.txt");
  writeFileSync(file, "hello");
  browser = await Browser.open(`${url}hidden`);
  const page = await browser.observe();
  const uploads = page.actions.filter((a: Action) => a.kind === "upload");
  // The closed dialog's input and the one with two buttons beside it are not offered.
  expect(uploads.map((a: Action) => a.label)).toEqual(["Attach CV", "Choose photo", "Overlay"]);
  expect(uploads.every((a: Action) => a.hidden === true)).toBe(true);
  let current = page;
  for (const action of uploads) {
    await (browser as Browser).act(action, current, file);
    current = await (browser as Browser).observe();
  }
  expect(await (browser as Browser).evaluate("document.getElementById('out').textContent")).toBe(
    "a:cv.txt;b:cv.txt;c:cv.txt;",
  );
});

test("a hidden file input that changed is not given a file", async () => {
  browser = await Browser.open(`${url}hidden`);
  const page = await browser.observe();
  const upload = find(page, (a) => a.kind === "upload");
  await browser.evaluate("document.querySelector('label[for=a]').textContent = 'Something else'");
  await expect(browser.act(upload, page, "/etc/hostname")).rejects.toThrow(StalePage);
});
