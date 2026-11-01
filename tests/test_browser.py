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
    result = run_agent(browser, ScriptedPolicy(task.SCRIPT), task.GOAL, recorder)
    recorder.close()
    assert result["status"] == "done"
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
