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
FIELDS = ("operation", "role", "label", "value", "checked", "reason", "url", "title", "text")
KINDS = {"action", "page", "unsupported"}


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
        fields = {key: event[key] for key in FIELDS if key in event}
        write(event["kind"], **{k: v[:2000] if isinstance(v, str) else v for k, v in fields.items()})

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
