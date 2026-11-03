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
