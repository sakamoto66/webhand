"""Records what a person demonstrates in a disposable Chrome. Claude turns the record into a runbook.

The record is untrusted: pages can forge binding calls, so it only ever becomes a draft for review.
"""

import time
from collections import Counter
from collections.abc import Callable
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError

from .browser import READ_STATE, Browser
from .metrics import Recorder

RECORDER = Path(__file__).with_name("recorder.js").read_text().replace("__SNAPSHOT__", READ_STATE.strip())
FIELDS = ("operation", "role", "label", "value", "checked", "reason", "url", "title", "text", "region")
KINDS = {"action", "page", "unsupported"}
MAX_REGIONS = 60
REGION_FIELDS = {"key": str, "position": str, "text_chars": int, "actions": int, "offscreen_actions": int}


def clip(value):
    return value[:2000] if isinstance(value, str) else value


def outline(regions) -> list[dict]:
    """The page's region outline, keeping only well-typed fields. A page can send anything here."""
    if not isinstance(regions, list):
        return []
    kept = []
    for region in regions[:MAX_REGIONS]:
        if isinstance(region, dict):
            kept.append(
                {
                    key: region[key][:200] if kind is str else region[key]
                    for key, kind in REGION_FIELDS.items()
                    if type(region.get(key)) is kind
                }
            )
    return kept


def record(browser: Browser, url: str, recorder: Recorder, until: Callable[[], bool]) -> Counter:
    """Records until the window closes or until() is true. Returns how many events of each kind."""
    counts: Counter = Counter()
    started = time.monotonic()

    def write(kind: str, **fields) -> None:
        counts[kind] += 1
        recorder.event(kind, at_ms=round((time.monotonic() - started) * 1000), **fields)

    def receive(_source, event) -> None:
        if not isinstance(event, dict) or event.get("kind") not in KINDS:
            return
        fields = {key: clip(event[key]) for key in FIELDS if key in event}
        if event["kind"] == "page":
            fields["regions"] = outline(event.get("regions"))
        write(event["kind"], **fields)

    context = browser.context
    context.expose_binding("__browserLabRecord", receive)
    context.add_init_script(RECORDER)
    context.on("page", lambda _page: write("unsupported", reason="new_tab"))
    browser.page.goto(url, wait_until="load")
    while browser.browser.is_connected() and context.pages and not until():
        try:
            context.pages[0].wait_for_timeout(100)
        except PlaywrightError:  # The window closed while waiting.
            continue
    return counts
