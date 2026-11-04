/**
 * Reserve a stay on HOTEL PLANISPHERE, a public practice site for test automation.
 *
 * Nothing is sent to a server: the site keeps the reservation in sessionStorage and shows a dialog.
 * Use dummy values only. The page content goes to Jev.
 */

import type { Browser } from "../src/browser.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";

const URL = "https://hotel-example-site.takeyaqa.dev/ja/reserve.html?plan-id=0";

// Pricing from the site's src/lib/billing.js and data/ja/plan_data.json (plan 0).
const ROOM_BILL = 7000;
const ADDITIONAL_PLAN_PRICE = 1000;
const WEEKEND_RATE = 0.25;

const TERM = 2;
const HEAD_COUNT = 2;
const USERNAME = "テスト太郎";
const EMAIL = "test@example.com";
const SETTLE_MS = 5000;

/** A local calendar date, without a time of day. */
function addDays(day: Date, days: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
}

/** Monday is 0 and Sunday is 6 (Monday-first weekday). */
function weekday(day: Date): number {
  return (day.getDay() + 6) % 7;
}

/**
 * The first Friday at least 14 days ahead, so the stay includes a Saturday night.
 * The site accepts dates from tomorrow to 90 days ahead.
 */
export function checkIn(today = new Date()): Date {
  const day = addDays(today, 14);
  return addDays(day, (((4 - weekday(day)) % 7) + 7) % 7);
}

export function totalBill(start: Date, term: number, headCount: number, breakfast: boolean): number {
  let total = ROOM_BILL * headCount * term;
  for (let i = 0; i < term; i++) {
    if (weekday(addDays(start, i)) >= 5) total += Math.trunc(ROOM_BILL * WEEKEND_RATE * headCount);
  }
  if (breakfast) total += ADDITIONAL_PLAN_PRICE * headCount * term;
  return total;
}

function longDate(day: Date): string {
  return `${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日`;
}

/** %Y/%m/%d */
function slashDate(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}/${pad(day.getMonth() + 1)}/${pad(day.getDate())}`;
}

const CHECK_IN = checkIn();
const CHECK_OUT = addDays(CHECK_IN, TERM);
const EXPECTED_TOTAL = totalBill(CHECK_IN, TERM, HEAD_COUNT, true);

export const GOAL =
  `Reserve the お得な特典付きプラン: check-in ${slashDate(CHECK_IN)}, ${TERM} nights, ` +
  `${HEAD_COUNT} guests, with 朝食バイキング and no other additional plans. ` +
  `Name ${USERNAME}. Confirmation by email to ${EMAIL}. Leave the request field empty. ` +
  "Review the confirmation page, then press この内容で予約する. " +
  "Stop when 予約を完了しました is shown. Do not close that dialog.";

export const SCRIPT: ScriptStep[] = [
  { operation: "TYPE_TEXT", label: "宿泊日", text: slashDate(CHECK_IN) },
  // The date picker opens over 宿泊数, 人数 and 朝食バイキング.
  { operation: "CLICK", label: "閉じる" },
  { operation: "TYPE_TEXT", label: "宿泊数", text: String(TERM) },
  { operation: "TYPE_TEXT", label: "人数", text: String(HEAD_COUNT) },
  { operation: "CLICK", label: "朝食バイキング" },
  { operation: "TYPE_TEXT", label: "氏名", text: USERNAME },
  { operation: "SELECT", label: "メールでのご連絡" },
  { operation: "TYPE_TEXT", label: "メールアドレス", text: EMAIL },
  // The button sits high in the right-hand column, above the fields filled last.
  { operation: "SCROLL_UP" },
  { operation: "CLICK", label: "予約内容を確認する" },
  { operation: "CLICK", label: "この内容で予約する" },
];

const READ_CONFIRMATION = `(() => {
  const text = id => document.getElementById(id)?.innerText.trim() ?? null;
  const modal = document.getElementById('success-modal');
  return {
    path: location.pathname,
    total: text('total-bill'),
    plan: text('plan-name'),
    term: text('term'),
    headCount: text('head-count'),
    plans: [...document.querySelectorAll('#plans li')].map(li => li.innerText.trim()),
    plansText: text('plans'),
    username: text('username'),
    contact: text('contact'),
    comment: text('comment'),
    completed: !!modal && modal.classList.contains('show')
      && getComputedStyle(modal).display !== 'none',
    completedTitle: modal?.querySelector('.modal-title')?.innerText.trim() ?? null,
  };
})()`;

export function startUrl(_root: string): string {
  return URL;
}

/**
 * Reads the confirmation page directly. It does not look at the agent's DONE or its history.
 * The expected total is computed here from the intended values, not read from the form.
 */
export async function verify(browser: Browser): Promise<Verdict> {
  // Read-only polling: the page renders after load and the dialog fades in after the click.
  const deadline = performance.now() + SETTLE_MS;
  let state: Record<string, unknown>;
  while (true) {
    state = (await browser.evaluate(READ_CONFIRMATION)) || {};
    if (state.completed || performance.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const digits = String(state.total || "").replace(/\D/g, "");
  const checks = {
    on_confirm_page: String(state.path || "").endsWith("/ja/confirm.html"),
    completed: state.completed === true && state.completedTitle === "予約を完了しました",
    plan: state.plan === "お得な特典付きプラン",
    term: state.term === `${longDate(CHECK_IN)} 〜 ${longDate(CHECK_OUT)} ${TERM}泊`,
    head_count: state.headCount === `${HEAD_COUNT}名様`,
    additional_plans: JSON.stringify(state.plans) === JSON.stringify(["朝食バイキング"]),
    username: state.username === `${USERNAME}様`,
    contact: state.contact === `メール：${EMAIL}`,
    comment: state.comment === "なし",
    total: digits === String(EXPECTED_TOTAL),
  };
  return {
    success: Object.values(checks).every(Boolean),
    evidence: { checks, expected_total: EXPECTED_TOTAL, observed: state },
  };
}
