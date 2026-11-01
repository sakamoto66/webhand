"""Offline loop behaviour with a fake browser. No model or Chrome."""

import pytest

from browser_lab.agent import Budget, run_agent
from browser_lab.metrics import Recorder
from browser_lab.types import Decision, ModelCall, MutationUncertain, PolicyError, StalePage

FILL = {"id": "e1", "kind": "fill", "label": "Destination", "node": 1, "value": ""}
CLICK = {"id": "e2", "kind": "click", "label": "Go", "node": 2}


def page(marker="a"):
    return {"url": "u", "title": "t", "text": "x", "actions": [FILL, CLICK], "marker": marker}


class FakeBrowser:
    def __init__(self, act_errors=()):
        self.act_errors = list(act_errors)
        self.acts = []
        self.count = 0
        self.observes = 0

    def observe(self):
        self.observes += 1
        self.count += 1
        return page(str(self.count))

    def fresh(self, _page, _action=None):
        return True

    def act(self, action, _page, text=None):
        self.acts.append((action["id"], text))
        if self.act_errors:
            raise self.act_errors.pop(0)


class FakePolicy:
    name = "fake"

    def __init__(self, decisions):
        self.decisions = list(decisions)
        self.calls = []
        self.text_calls = 0

    def choose(self, _page, _goal, _history):
        self.calls.append(ModelCall("p", "m", "choose", 1))
        result = self.decisions.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    def text(self, _context):
        self.text_calls += 1
        self.calls.append(ModelCall("p", "m", "text", 1))
        return "Lisbon"


@pytest.fixture
def recorder(tmp_path):
    instance = Recorder(tmp_path / "run.jsonl")
    yield instance
    instance.close()


def test_done_is_reported_without_claiming_success(recorder):
    result = run_agent(FakeBrowser(), FakePolicy([Decision("DONE")]), "g", recorder)
    assert result["status"] == "done"
    assert "verified" not in result


def test_stale_page_chooses_again(recorder):
    browser = FakeBrowser([StalePage("moved")])
    policy = FakePolicy([Decision("CLICK", CLICK), Decision("CLICK", CLICK), Decision("DONE")])
    result = run_agent(browser, policy, "g", recorder)
    assert result["status"] == "done"
    assert result["actions"] == 1
    assert result["decisions"] == 3


def test_uncertain_mutation_stops_and_is_never_retried(recorder):
    browser = FakeBrowser([MutationUncertain("interrupted")])
    policy = FakePolicy([Decision("CLICK", CLICK), Decision("CLICK", CLICK)])
    result = run_agent(browser, policy, "g", recorder)
    assert result["status"] == "error"
    assert len(browser.acts) == 1


def test_rejected_model_output_is_logged_and_executes_nothing(recorder):
    browser = FakeBrowser()
    policy = FakePolicy([PolicyError("invalid")])
    result = run_agent(browser, policy, "g", recorder)
    assert result["status"] == "error"
    assert browser.acts == []
    assert len(recorder.calls) == 1


def test_budget_stops_the_run(recorder):
    policy = FakePolicy([Decision("WAIT", {"id": "wait", "kind": "wait", "label": "Wait"})] * 5)
    result = run_agent(FakeBrowser(), policy, "g", recorder, Budget(max_actions=2))
    assert result["status"] == "budget"
    assert result["actions"] == 2


def test_three_unchanged_pages_block(recorder):
    class Static(FakeBrowser):
        def observe(self):
            return page("same")

    policy = FakePolicy([Decision("CLICK", CLICK)] * 3)
    result = run_agent(Static(), policy, "g", recorder)
    assert result["status"] == "blocked"


def test_text_is_reused_after_stale_when_context_is_identical(recorder):
    class SamePage(FakeBrowser):
        def observe(self):
            return page("same")

    browser = SamePage([StalePage("moved")])
    policy = FakePolicy([Decision("TYPE_TEXT", FILL), Decision("TYPE_TEXT", FILL), Decision("DONE")])
    run_agent(browser, policy, "g", recorder)
    assert policy.text_calls == 1
    assert browser.acts == [("e1", "Lisbon"), ("e1", "Lisbon")]
