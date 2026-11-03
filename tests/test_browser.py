"""Real headless Chrome on the local fixture. No model calls."""

import importlib.util
from pathlib import Path

import pytest

from browser_lab.agent import run_agent
from browser_lab.browser import Browser
from browser_lab.metrics import Recorder
from browser_lab.policies.scripted import ScriptedPolicy
from browser_lab.types import StalePage

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("hotel_filter", ROOT / "tasks" / "hotel_filter.py")
task = importlib.util.module_from_spec(spec)
spec.loader.exec_module(task)


@pytest.fixture
def browser():
    instance = Browser(task.start_url(ROOT))
    yield instance
    instance.close()


def test_scripted_run_passes_independent_verification(browser, tmp_path):
    recorder = Recorder(tmp_path / "run.jsonl")
    plan = {"goal": task.GOAL, "steps": [], "values": []}
    result = run_agent(browser, ScriptedPolicy(task.SCRIPT), plan, recorder)
    recorder.close()
    assert result["outcome"] == "GOAL_REPORTED"
    assert task.verify(browser)["success"] is True


def test_verifier_fails_when_the_task_was_not_done(browser):
    assert task.verify(browser)["success"] is False


def test_stale_decision_is_not_executed(browser):
    page = browser.observe()
    button = next(a for a in page["actions"] if a["label"] == "Find stays")
    browser.evaluate("document.getElementById('destination').value='changed'")
    with pytest.raises(StalePage):
        browser.act(button, page)
    assert task.verify(browser)["evidence"]["opened_casa_flora"] is False


def test_password_values_are_not_observed(browser):
    browser.evaluate(
        "const p=document.createElement('input');p.type='password';p.value='hunter2';"
        "p.setAttribute('aria-label','Secret');document.body.prepend(p);"
    )
    page = browser.observe()
    assert "hunter2" not in str(page)
    assert all(a["label"] != "Secret" for a in page["actions"])


def test_open_shadow_dom_is_observed_and_clickable(browser):
    browser.evaluate(
        """(() => {
          const host=document.createElement('div'); document.body.prepend(host);
          const root=host.attachShadow({mode:'open'});
          root.innerHTML='<p>Shadow notice</p><span id="t">Shadow save</span>'+
            '<button aria-labelledby="t">x</button><slot-host><span>Slotted go</span></slot-host>';
          const inner=root.querySelector('slot-host').attachShadow({mode:'open'});
          inner.innerHTML='<button><slot></slot></button>';
          root.querySelector('button').onclick=()=>host.dataset.saved='1';
          inner.querySelector('button').onclick=()=>host.dataset.went='1';
          window.__shadowHost=host;
        })()"""
    )
    page = browser.observe()
    assert "Shadow notice" in page["text"]
    save = next(a for a in page["actions"] if a["label"] == "Shadow save")
    go = next(a for a in page["actions"] if a["label"] == "Slotted go")
    browser.act(save, page)
    browser.act(go, browser.observe())
    assert browser.evaluate("({...window.__shadowHost.dataset})") == {"saved": "1", "went": "1"}


def test_script_clickable_elements_without_a_role_are_observed_once(browser):
    browser.evaluate(
        """(() => {
          const box=document.createElement('div'); document.body.prepend(box);
          box.innerHTML='<h3 id="area" style="cursor:pointer">Kanto<span>AREA</span></h3>'+
            '<div style="cursor:pointer" id="card"><a href="#x">Card link</a></div>'+
            '<span onclick="1">Inline handler</span><div tabindex="0">Focusable</div>'+
            '<label style="cursor:pointer">Label text</label><p style="cursor:pointer"></p>'+
            '<iframe tabindex="0" title="Ad"></iframe>'+
            // An anchor's .host is a URL string, not a shadow host.
            '<a id="remote" href="https://example.com/x" style="display:block;padding:0">'+
            '<span style="display:block;height:40px">Remote link</span></a>';
          box.querySelector('#area').addEventListener('click', () => box.dataset.opened='1');
          box.querySelector('#remote').addEventListener('click', e => { e.preventDefault(); box.dataset.went='1'; });
          window.__box=box;
        })()"""
    )
    page = browser.observe()
    clickable = [a["label"] for a in page["actions"] if a.get("role") == "clickable"]
    assert clickable == ["Kanto AREA", "Inline handler", "Focusable"]
    assert [a["label"] for a in page["actions"]].count("Card link") == 1
    area = next(a for a in page["actions"] if a["label"] == "Kanto AREA")
    browser.act(area, page)
    assert browser.evaluate("window.__box.dataset.opened") == "1"
    page = browser.observe()
    remote = next(a for a in page["actions"] if a["label"] == "Remote link")
    assert remote["role"] == "link"
    browser.act(remote, page)  # The click lands on the span inside the link.
    assert browser.evaluate("window.__box.dataset.went") == "1"


def test_a_wrapped_inline_link_is_clicked_on_one_of_its_lines(browser):
    browser.evaluate(
        """(() => {
          const li=document.createElement('li'); li.style.cssText='list-style:none;width:400px';
          li.innerHTML='Leading text that fills most of the line <a id="wrapped" href="#w">Short<br>Next</a>';
          li.querySelector('a').addEventListener('click', e => { e.preventDefault(); li.dataset.went='1'; });
          document.body.prepend(li); window.__li=li;
        })()"""
    )
    # The link starts at the end of one line and ends at the start of the next, so its box spans the line and
    # the center of that box falls on the leading text, outside the link.
    assert browser.evaluate(
        "(() => { const r=document.getElementById('wrapped').getBoundingClientRect();"
        " return document.elementFromPoint(r.x+r.width/2, r.y+r.height/2) === window.__li; })()"
    )
    page = browser.observe()
    link = next(a for a in page["actions"] if a["label"].startswith("Short"))
    browser.act(link, page)
    assert browser.evaluate("window.__li.dataset.went") == "1"


def test_observe_waits_for_content_rendered_after_load(tmp_path):
    page = tmp_path / "late.html"
    page.write_text(
        "<!doctype html><meta charset='utf-8'><body><h1>Shell</h1><script>"
        "addEventListener('load', () => setTimeout(() => {"
        "const b=document.createElement('button'); b.textContent='Loaded later'; document.body.append(b);"
        "}, 100));</script></body>"
    )
    instance = Browser(page.as_uri())
    try:
        observed = instance.observe()
    finally:
        instance.close()
    assert "Loaded later" in observed["text"]
    assert any(a["label"] == "Loaded later" for a in observed["actions"])


def test_observe_returns_at_the_cap_on_a_page_that_never_settles(tmp_path):
    import time

    from browser_lab.browser import SETTLE_CAP_MS

    page = tmp_path / "busy.html"
    page.write_text(
        "<!doctype html><body><p id='t'>0</p><script>"
        "setInterval(() => { t.textContent = Date.now(); }, 20);</script></body>"
    )
    instance = Browser(page.as_uri())
    try:
        started = time.perf_counter()
        instance.observe()
        elapsed = time.perf_counter() - started
    finally:
        instance.close()
    assert elapsed < SETTLE_CAP_MS / 1000 + 1.5


# --- Regions and views ---------------------------------------------------------------------

DENSE = ROOT / "tasks" / "fixtures" / "dense.html"
FORM = "main:Booking/form:Booking"


@pytest.fixture
def dense():
    instance = Browser(DENSE.as_uri())
    yield instance
    instance.close()


def regions(page):
    return {region["key"]: region for region in page["regions"]}


def test_without_a_view_the_outline_shows_what_was_cut(dense):
    page = dense.observe()
    outline = regions(page)
    assert page["omitted_actions"] == 191
    assert (outline["header:Dense shop/nav:Categories"]["shown_actions"], outline[FORM]["shown_actions"]) == (250, 0)
    assert outline[FORM]["actions"] == 141
    assert outline["main:Booking/section:Notes"]["position"] == "below"
    assert all("view" not in region for region in page["regions"])
    assert "## " not in page["text"]


def test_a_view_shows_focused_regions_first_and_leaves_skipped_ones_out(dense):
    dense.view = {"focus": ["form:Booking", "section:Notes"], "skip": ["header"]}
    page = dense.observe()
    labels = [a["label"] for a in page["actions"] if a.get("node")]
    assert labels[0].startswith("Arrival") and "Book" in labels
    assert not any(label.startswith("Category") for label in labels)
    assert page["text"].startswith("## " + FORM)
    assert "Cancellation is free" in page["text"]  # Focused text is read from the whole page.
    assert "Category 1" not in page["text"]
    outline = regions(page)
    assert outline["header:Dense shop/nav:Categories"]["view"] == "skip"
    assert outline[FORM]["view"] == "focus"
    assert outline[FORM]["shown_actions"] == 141


def test_the_view_does_not_change_freshness(dense):
    plain = dense.observe()
    dense.view = {"focus": ["form"], "skip": ["nav"]}
    viewed = dense.observe()
    assert [viewed[k] for k in ("marker", "page_key", "guards")] == [plain[k] for k in ("marker", "page_key", "guards")]
    assert dense.fresh(viewed)


def test_a_focused_action_runs_like_any_other(dense):
    dense.view = {"focus": ["form:Booking"]}
    page = dense.observe()
    book = next(a for a in page["actions"] if a["label"] == "Book")
    dense.act(book, page)
    assert dense.evaluate("document.body.dataset.booked") == "1"


def test_region_keys_are_stable_and_hold_no_secrets(dense):
    first, second = dense.observe(), dense.observe()
    assert [r["key"] for r in first["regions"]] == [r["key"] for r in second["regions"]]
    dense.view = {"focus": ["form"]}
    assert "hunter2" not in str(dense.observe())


def test_an_open_dialog_comes_first_in_a_view(dense):
    dense.evaluate("document.getElementById('welcome').showModal()")
    dense.view = {"focus": ["form"]}
    page = dense.observe()
    assert page["actions"][0]["label"] == "Close offer"
    assert page["text"].startswith("## dialog:Welcome")


def test_a_bare_kind_matches_any_region_of_that_kind_and_the_deepest_match_wins(dense):
    dense.view = {"focus": ["form"], "skip": ["main"]}
    page = dense.observe()
    outline = regions(page)
    assert outline[FORM]["view"] == "focus"
    assert outline["main:Booking"]["view"] == "skip"
    assert "Cancellation" not in page["text"]


def test_a_heading_names_a_region_only_when_it_opens_it(tmp_path):
    page = tmp_path / "names.html"
    page.write_text(
        "<!doctype html><meta charset='utf-8'><body>"
        "<form><label>Date <input></label><h3>Total</h3></form>"
        "<section aria-label='Notes'><p>Note</p></section><aside><h2>Help</h2><a href='#h'>Ask</a></aside></body>"
    )
    instance = Browser(page.as_uri())
    try:
        keys = [r["key"] for r in instance.observe()["regions"]]
    finally:
        instance.close()
    assert keys == ["form", "section:Notes", "aside:Help"]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tasks" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("view", [None, {"focus": ["form:Booking"], "skip": ["header"]}])
def test_dense_booking_passes_verification_with_and_without_a_view(view, tmp_path):
    dense_task = load("dense_booking")
    instance = Browser(dense_task.start_url(ROOT), view=view)
    try:
        assert dense_task.verify(instance)["success"] is False
        recorder = Recorder(tmp_path / "run.jsonl")
        plan = {"goal": dense_task.GOAL, "steps": [], "values": []}
        result = run_agent(instance, ScriptedPolicy(dense_task.SCRIPT), plan, recorder)
        recorder.close()
        assert result["outcome"] == "GOAL_REPORTED"
        assert dense_task.verify(instance)["success"] is True
    finally:
        instance.close()
