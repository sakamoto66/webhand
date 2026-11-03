"""Reserve a stay on HOTEL PLANISPHERE, a public practice site for test automation.

Nothing is sent to a server: the site keeps the reservation in sessionStorage and shows a dialog.
Use dummy values only. The page content goes to Jev.
"""

import re
import time
from datetime import date, timedelta
from pathlib import Path

URL = "https://hotel-example-site.takeyaqa.dev/ja/reserve.html?plan-id=0"

# Pricing from the site's src/lib/billing.js and data/ja/plan_data.json (plan 0).
ROOM_BILL = 7000
ADDITIONAL_PLAN_PRICE = 1000
WEEKEND_RATE = 0.25

TERM = 2
HEAD_COUNT = 2
USERNAME = "テスト太郎"
EMAIL = "test@example.com"
SETTLE_SECONDS = 5


def check_in(today: date | None = None) -> date:
    """The first Friday at least 14 days ahead, so the stay includes a Saturday night.

    The site accepts dates from tomorrow to 90 days ahead.
    """
    day = (today or date.today()) + timedelta(days=14)
    return day + timedelta(days=(4 - day.weekday()) % 7)


def total_bill(start: date, term: int, head_count: int, breakfast: bool) -> int:
    total = ROOM_BILL * head_count * term
    for i in range(term):
        if (start + timedelta(days=i)).weekday() >= 5:
            total += int(ROOM_BILL * WEEKEND_RATE * head_count)
    if breakfast:
        total += ADDITIONAL_PLAN_PRICE * head_count * term
    return total


def long_date(day: date) -> str:
    return f"{day.year}年{day.month}月{day.day}日"


CHECK_IN = check_in()
CHECK_OUT = CHECK_IN + timedelta(days=TERM)
EXPECTED_TOTAL = total_bill(CHECK_IN, TERM, HEAD_COUNT, breakfast=True)

GOAL = (
    f"Reserve the お得な特典付きプラン: check-in {CHECK_IN:%Y/%m/%d}, {TERM} nights, "
    f"{HEAD_COUNT} guests, with 朝食バイキング and no other additional plans. "
    f"Name {USERNAME}. Confirmation by email to {EMAIL}. Leave the request field empty. "
    "Review the confirmation page, then press この内容で予約する. "
    "Stop when 予約を完了しました is shown. Do not close that dialog."
)

SCRIPT = [
    {"operation": "TYPE_TEXT", "label": "宿泊日", "text": f"{CHECK_IN:%Y/%m/%d}"},
    # The date picker opens over 宿泊数, 人数 and 朝食バイキング.
    {"operation": "CLICK", "label": "閉じる"},
    {"operation": "TYPE_TEXT", "label": "宿泊数", "text": str(TERM)},
    {"operation": "TYPE_TEXT", "label": "人数", "text": str(HEAD_COUNT)},
    {"operation": "CLICK", "label": "朝食バイキング"},
    {"operation": "TYPE_TEXT", "label": "氏名", "text": USERNAME},
    {"operation": "SELECT", "label": "メールでのご連絡"},
    {"operation": "TYPE_TEXT", "label": "メールアドレス", "text": EMAIL},
    # The button sits high in the right-hand column, above the fields filled last.
    {"operation": "SCROLL_UP"},
    {"operation": "CLICK", "label": "予約内容を確認する"},
    {"operation": "CLICK", "label": "この内容で予約する"},
]

READ_CONFIRMATION = """(() => {
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
})()"""


def start_url(root: Path) -> str:
    return URL


def verify(browser) -> dict:
    """Reads the confirmation page directly. It does not look at the agent's DONE or its history.

    The expected total is computed here from the intended values, not read from the form.
    """
    # Read-only polling: the page renders after load and the dialog fades in after the click.
    deadline = time.monotonic() + SETTLE_SECONDS
    while True:
        state = browser.evaluate(READ_CONFIRMATION) or {}
        if state.get("completed") or time.monotonic() >= deadline:
            break
        time.sleep(0.2)
    digits = re.sub(r"\D", "", state.get("total") or "")
    checks = {
        "on_confirm_page": (state.get("path") or "").endswith("/ja/confirm.html"),
        "completed": state.get("completed") is True and state.get("completedTitle") == "予約を完了しました",
        "plan": state.get("plan") == "お得な特典付きプラン",
        "term": state.get("term") == f"{long_date(CHECK_IN)} 〜 {long_date(CHECK_OUT)} {TERM}泊",
        "head_count": state.get("headCount") == f"{HEAD_COUNT}名様",
        "additional_plans": state.get("plans") == ["朝食バイキング"],
        "username": state.get("username") == f"{USERNAME}様",
        "contact": state.get("contact") == f"メール：{EMAIL}",
        "comment": state.get("comment") == "なし",
        "total": digits == str(EXPECTED_TOTAL),
    }
    return {
        "success": all(checks.values()),
        "evidence": {"checks": checks, "expected_total": EXPECTED_TOTAL, "observed": state},
    }
