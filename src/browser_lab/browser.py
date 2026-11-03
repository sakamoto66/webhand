"""Playwright launches an isolated Chrome; observation and input go through one CDP session."""

import json
import sys
import time
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

from .types import Action, MutationUncertain, Page, StalePage

READ_STATE = Path(__file__).with_name("snapshot.js").read_text()
MARKER = f"(() => {{ const state={READ_STATE}; return state?.marker ?? null; }})()"
# Read only once the document has loaded and the DOM has stopped changing, so content rendered by
# DOMContentLoaded handlers or after an XHR is observed. A page that never goes quiet is read at the cap.
SETTLE_QUIET_MS = 150
SETTLE_CAP_MS = 2000
SETTLE = f"""new Promise(resolve => {{
  const start = performance.now();
  let last = start;
  const observer = new MutationObserver(() => {{ last = performance.now(); }});
  observer.observe(document, {{subtree: true, childList: true, attributes: true, characterData: true}});
  const check = () => {{
    const now = performance.now();
    if (now - start >= {SETTLE_CAP_MS} ||
        (document.readyState === 'complete' && now - last >= {SETTLE_QUIET_MS})) {{
      observer.disconnect();
      resolve();
    }} else setTimeout(check, 25);
  }};
  check();
}})"""
# Node ids are code-owned references to observed elements, never model output.
RESOLVE_TARGET = """(action => {
  const c=window.__browserLab, e=c?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || c.closest(e,'[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  if (!c.hit(e,x,y)) return null;
  return {x,y};
})"""
SELECT_OPTION = """(action => {
  const e=window.__browserLab.nodes.get(action.node);
  if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
      !o.disabled && !o.closest('optgroup[disabled]'))) return false;
  e.value=action.value;
  e.dispatchEvent(new Event('input',{bubbles:true}));
  e.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
})"""


class Browser:
    def __init__(self, url: str | None = None, *, headless: bool = True, port: int | None = None):
        """Launch a throwaway Chrome for url, or attach to the session Chrome on port."""
        self.playwright = sync_playwright().start()
        self.attached = port is not None
        try:
            if self.attached:
                self.browser = self.playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
                self.context = self.browser.contexts[0]
                if url:
                    # A saved profile may restore old tabs. The run owns exactly one fresh tab.
                    stale = list(self.context.pages)
                    self.page = self.context.new_page()
                    for page in stale:
                        page.close()
                    self.page.goto(url, wait_until="load")
                else:
                    self.page = self.context.pages[0]
                self.cdp = self.context.new_cdp_session(self.page)
                return
            # launch() uses a throwaway profile. Never point this at a signed-in profile.
            self.browser = self.playwright.chromium.launch(channel="chrome", headless=headless)
            self.context = self.browser.new_context(viewport={"width": 1120, "height": 780})
            self.page = self.context.new_page()
            self.cdp = self.context.new_cdp_session(self.page)
            self.page.goto(url, wait_until="load")
        except Exception:
            self.close()
            raise

    @property
    def version(self) -> str:
        return self.browser.version

    def call(self, method: str, **params):
        return self.cdp.send(method, params)

    def evaluate(self, expression: str, *, await_promise: bool = False):
        """Read-only evaluation. A navigation in progress surfaces as StalePage."""
        try:
            response = self.call(
                "Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=await_promise
            )
        except PlaywrightError as error:
            raise StalePage("Document changed during evaluation") from error
        if response.get("exceptionDetails"):
            raise StalePage("Document changed during evaluation")
        return response.get("result", {}).get("value")

    def observe(self) -> Page:
        for _ in range(10):
            try:
                self.evaluate(SETTLE, await_promise=True)
                state = self.evaluate(READ_STATE)
            except StalePage:
                state = None
            if state is not None:
                return state
            time.sleep(0.02)
        raise StalePage("Page did not settle")

    def fresh(self, page: Page, action: Action | None = None) -> bool:
        if action is not None and action["kind"] in {"click", "select"}:
            node = action["node"]
            if type(node) is not int:
                return False
            current = self.evaluate(
                "(() => { const c=window.__browserLab; "
                f"return c ? [c.pageKey(),c.guard(c.nodes.get({node}))] : null; }})()"
            )
            return current == [page["page_key"], page["guards"].get(str(node))]
        return self.evaluate(MARKER) == page["marker"]

    def act(self, action: Action, page: Page, text: str | None = None) -> None:
        """Execute once. StalePage means nothing happened; MutationUncertain means do not retry."""
        if not self.fresh(page, action):
            raise StalePage("Page changed since this decision")
        kind = action["kind"]
        if kind == "wait":
            time.sleep(0.1)
            return
        target = None
        if kind != "scroll":
            target = self.evaluate(f"{RESOLVE_TARGET}({json.dumps(action)})")
            if target is None:
                raise StalePage("Target changed or is covered")
        try:
            if kind == "scroll":
                self.call("Input.dispatchMouseEvent", type="mouseWheel", x=550, y=650, deltaX=0, deltaY=action["delta"])
            elif kind == "select":
                self._select(action)
            else:
                self._click(target["x"], target["y"])
                if kind == "fill":
                    self._replace_text(text)
        except PlaywrightError as error:
            raise MutationUncertain(f"{kind} was interrupted") from error

    def _click(self, x: float, y: float) -> None:
        for event in ("mousePressed", "mouseReleased"):
            self.call("Input.dispatchMouseEvent", type=event, x=x, y=y, button="left", clickCount=1)

    def _select(self, action: Action) -> None:
        response = self.call(
            "Runtime.evaluate", expression=f"{SELECT_OPTION}({json.dumps(action)})", returnByValue=True
        )
        if response.get("result", {}).get("value") is not True:
            raise MutationUncertain("Dropdown change was not confirmed")

    def _replace_text(self, text: str | None) -> None:
        if text is None:
            raise MutationUncertain("Field was focused without text")
        modifier = 4 if sys.platform == "darwin" else 2
        key = dict(key="a", code="KeyA", modifiers=modifier)
        self.call("Input.dispatchKeyEvent", type="keyDown", commands=["selectAll"], **key)
        self.call("Input.dispatchKeyEvent", type="keyUp", **key)
        self.call("Input.insertText", text=text)

    def close(self) -> None:
        """An attached session Chrome stays alive; only session.stop_chrome() ends it."""
        browser = getattr(self, "browser", None)
        if browser and not self.attached:
            browser.close()
        self.playwright.stop()
