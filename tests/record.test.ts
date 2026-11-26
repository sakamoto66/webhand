/** Recording a demonstration on real Chrome, with trusted input as a person would produce it. */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page as PlaywrightPage } from "playwright-core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Browser } from "../src/browser/index.ts";
import { parse } from "../src/cli.ts";
import { Recorder } from "../src/core/metrics.ts";
import * as demo from "../src/record.ts";
import * as session from "../src/storage/session.ts";
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
  log = join(dir, "record.jsonl");
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
  return demo.record(browser, pathToFileURL(join(dir, "form.html")).href, recorder, until);
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

// Each field carries one name, in one of the places the recorder looks at.
const SECRET_NAMES: [string, string][] = [
  ...["api_key", "api-key", "apiKey", "APIKEY", "user[api][key]", "private_key", "private-key", "privateKey"].map(
    (name): [string, string] => ["name", name],
  ),
  ...["credential", "userCredentials", "security_answer", "securityAnswer", "security-question-answer"].map(
    (name): [string, string] => ["id", name],
  ),
  ...["API key", "api.key", "Private Key", "Security answer", "Recovery phrase", "recovery_phrase"].map(
    (name): [string, string] => ["aria-label", name],
  ),
  ...[
    "recovery-phrase",
    "recoveryPhrase",
    "秘密の質問",
    "秘密の質問の答え",
    "ワンタイムコード",
    "ワンタイム・コード",
  ].map((name): [string, string] => ["placeholder", name]),
  ...["確認コード", "確認 コード", "セキュリティコード", "セキュリティーコード", "セキュリティ　コード"].map(
    (name): [string, string] => ["label", name],
  ),
  ...["口座番号", "マイナンバー"].map((name): [string, string] => ["label", name]),
  ...[
    "access_key",
    "accessKey",
    "security_code",
    "securityCode",
    "verification-code",
    "confirmation_code",
    "one_time_code",
    "oneTimeCode",
    "auth_code",
    "2fa_code",
    "mfaCode",
    "seed_phrase",
    "mnemonic",
    "security_question",
    "account_number",
    "accountNumber",
    "iban",
    "payerIban",
    "routing-number",
    "my_number",
    "mynumber",
    "user[access][key]",
  ].map((name): [string, string] => ["name", name]),
  ...[
    "Access key",
    "Security code",
    "Verification code",
    "Confirmation code",
    "One-time code",
    "one time code",
    "Auth code",
    "2FA code",
    "MFA code",
    "Seed phrase",
    "Security question",
    "Account number",
    "Routing number",
    "My Number",
  ].map((name): [string, string] => ["aria-label", name]),
  ...["個人番号", "個人 番号", "秘密の答え", "秘密の・答え", "合言葉", "認証番号", "認証・番号", "確認番号"].map(
    (name): [string, string] => ["label", name],
  ),
  ...["確認 番号", "口座名義", "口座 名義", "口座　番号"].map((name): [string, string] => ["placeholder", name]),
  ...["account_no", "accountNo", "account-no2", "user[account][no]", "routing_no", "routingNo", "routing.no"].map(
    (name): [string, string] => ["name", name],
  ),
  ...["two_factor_code", "twoFactorCode", "recovery_code", "recoveryCode"].map((name): [string, string] => [
    "id",
    name,
  ]),
  ...["Account No.", "Routing no", "Two-factor code", "Recovery code"].map((name): [string, string] => [
    "aria-label",
    name,
  ]),
  // Words that were already masked stay masked.
  ...["passwd", "user_pwd", "pw", "client_secret", "token", "otp", "cvv", "cvc", "card_no", "ssn", "pin"].map(
    (name): [string, string] => ["name", name],
  ),
  ...["パスワード", "暗証番号", "認証コード", "カード番号"].map((name): [string, string] => ["label", name]),
];
const PLAIN_NAMES = [
  ...["keyboard", "api_version", "private_note", "answer", "recovery_email", "確認事項", "商品コード"],
  ...["access_level", "account_type", "routing", "verification_status", "zip_code", "phone_number", "seed", "my_name"],
  ...["口座種別", "認証方式", "電話番号", "個人情報"],
  ...["account_notes", "accountNotes", "account_notification", "accountNotification", "account-note"],
  ...["routing_notes", "routing_node", "two_factor_method", "recovery_contact"],
];

test("fields with secret names are masked, however the name is separated", async () => {
  const fields = [...SECRET_NAMES, ...PLAIN_NAMES.map((name): [string, string] => ["name", name])];
  const inputs = fields.map(([where, name], i) =>
    where === "label" ? `<label>${name} <input data-n="${i}"></label>` : `<input data-n="${i}" ${where}="${name}">`,
  );
  writeFileSync(join(dir, "form.html"), `<title>Names</title>${inputs.join("<br>")}<br><button>End</button>`);
  await play([
    async (page) => {
      for (const i of fields.keys()) {
        await page.locator(`[data-n="${i}"]`).click();
        await page.keyboard.type(`value-${i}.`);
      }
      await page.getByRole("button").click();
    },
  ]);
  const values = actions()
    .steps.filter((s) => s.operation === "fill")
    .map((s) => s.value);
  const seen = fields.map(([where, name], i) => [where, name, values[i]]);
  expect(seen).toEqual(
    fields.map(([where, name], i) => [where, name, i < SECRET_NAMES.length ? "<redacted>" : `value-${i}.`]),
  );
  const text = readFileSync(log, "utf8");
  for (const i of SECRET_NAMES.keys()) expect(text).not.toContain(`value-${i}.`);
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

test("a new tab is recorded as a tab event, and what is done in it as actions", async () => {
  writeFileSync(join(dir, "form.html"), "<title>Start</title><a href='next.html' target='_blank'>Open next</a>");
  let opened: PlaywrightPage | undefined;
  await play([
    (p) => p.getByRole("link").click(),
    async () => {
      opened = browser.context.pages().find((page) => page.url().endsWith("next.html"));
      await opened?.getByRole("link", { name: "Back" }).click();
    },
    async () => {
      await opened?.close();
    },
  ]);
  const { steps, events } = actions();
  expect(events.filter((e) => e.type === "unsupported")).toEqual([]);
  expect(events.filter((e) => e.type === "tab").map((e) => [e.change, e.count])).toEqual([
    ["opened", 2],
    ["closed", 1],
  ]);
  expect(steps.map((s) => s.label)).toEqual(["Open next", "Back"]);
});

test("a page can only report that its tab came to the front", async () => {
  await play([
    (p) =>
      p.evaluate(
        "window.__browserLabRecord?.({kind:'tab', change:'opened', count: 9}) ?? dispatchEvent(new Event('x'))",
      ),
  ]);
  expect(actions().events.filter((e) => e.type === "tab")).toEqual([]);
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
  expect(Object.keys(outline[0]).every((key) => key in demo.REGION_FIELDS)).toBe(true);
  expect(readFileSync(log, "utf8")).not.toContain("Card number");
});

test("a forged outline keeps only typed fields", () => {
  expect(demo.outline("x")).toEqual([]);
  expect(demo.outline([{ key: "nav", actions: "9", extra: 1 }, 3])).toEqual([{ key: "nav" }]);
});

test("record is shown in main help while the legacy learn alias stays hidden and callable", () => {
  const mainHelp = parse(["--help"]);
  expect("help" in mainHelp && mainHelp.help).toContain("record");
  expect("help" in mainHelp && mainHelp.help).toContain("memory");
  expect("help" in mainHelp && mainHelp.help).not.toMatch(/\blearn\b/);
  expect("help" in mainHelp && mainHelp.help).not.toMatch(/\bknowledge\b/);

  const rec = parse(["record", "--name", "demo/flow", "--url", "https://example.test"]);
  const alias = parse(["learn", "--name", "demo/flow", "--url", "https://example.test"]);
  expect("run" in rec && "run" in alias && rec.run === alias.run).toBe(true);
});
