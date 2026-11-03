"""Offline loop behaviour with a fake browser. No model or Chrome."""

import json

import pytest

from webhand.agent import Budget, run_agent
from webhand.metrics import Recorder
from webhand.types import Decision, ModelCall, MutationUncertain, PolicyError, StalePage

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
    name = "jev"

    def __init__(self, decisions):
        self.decisions = list(decisions)
        self.calls = []

    def choose(self, _page, _goal, _history):
        self.calls.append(ModelCall("p", "m", "choose", 1))
        result = self.decisions.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


PLAN = {"goal": "g", "steps": [], "values": [{"label": "Destination", "value": "Lisbon"}]}


@pytest.fixture
def recorder(tmp_path):
    instance = Recorder(tmp_path / "run.jsonl")
    yield instance
    instance.close()


def run(browser, decisions, recorder, **options):
    return run_agent(browser, FakePolicy(decisions), PLAN, recorder, **options)


def test_done_is_reported_without_claiming_success(recorder):
    result = run(FakeBrowser(), [Decision("DONE")], recorder)
    assert result["outcome"] == "GOAL_REPORTED"
    assert "verified" not in result


def test_needs_human_and_blocked_return_to_claude(recorder):
    assert run(FakeBrowser(), [Decision("NEEDS_HUMAN")], recorder)["outcome"] == "NEEDS_HUMAN"
    assert run(FakeBrowser(), [Decision("BLOCKED")], recorder)["outcome"] == "BLOCKED"


def test_stale_page_chooses_again(recorder):
    browser = FakeBrowser([StalePage("moved")])
    result = run(browser, [Decision("CLICK", CLICK), Decision("CLICK", CLICK), Decision("DONE")], recorder)
    assert result["outcome"] == "GOAL_REPORTED"
    assert result["actions"] == 1
    assert result["decisions"] == 3


def test_a_refused_stale_choice_is_noted_without_counting_as_an_action(recorder):
    browser = FakeBrowser([StalePage("moved")])
    history = []
    result = run_agent(
        browser, FakePolicy([Decision("CLICK", CLICK), Decision("DONE")]), PLAN, recorder, history=history
    )
    assert result["outcome"] == "GOAL_REPORTED"
    assert result["actions"] == 0
    assert history[0]["operation"] == "STALE" and "did not run: moved" in history[0]["action"]
    assert history[0]["page_changed"] is True  # The page moved on, so this is not being stuck.
    events = [json.loads(line) for line in recorder.path.read_text().splitlines()]
    stale = [(e["wanted"], e["target"], e["reason"]) for e in events if e["type"] == "stale"]
    assert stale == [("CLICK", "Go", "moved")]


def test_a_target_refused_on_an_unchanged_page_is_stuck_after_three_tries(recorder):
    class Covered(FakeBrowser):
        def observe(self):
            return page("same")

    browser = Covered([StalePage("Target changed or is covered")] * 5)
    result = run(browser, [Decision("CLICK", CLICK)] * 5, recorder)
    assert result["outcome"] == "STUCK"
    assert result["decisions"] == 3
    assert result["actions"] == 0


def test_a_stale_observation_after_an_action_ran_is_not_noted_as_refused(recorder):
    class SlowToSettle(FakeBrowser):
        def observe(self):
            if self.acts and self.observes == 1:
                self.observes += 1
                raise StalePage("Page did not settle")
            return super().observe()

    browser = SlowToSettle()
    history = []
    result = run_agent(
        browser, FakePolicy([Decision("CLICK", CLICK), Decision("DONE")]), PLAN, recorder, history=history
    )
    assert result["outcome"] == "GOAL_REPORTED"
    assert [h["operation"] for h in history] == ["CLICK"]


def test_uncertain_mutation_stops_and_is_never_retried(recorder):
    browser = FakeBrowser([MutationUncertain("interrupted")])
    result = run(browser, [Decision("CLICK", CLICK), Decision("CLICK", CLICK)], recorder)
    assert result["outcome"] == "UNCERTAIN"
    assert len(browser.acts) == 1


def test_rejected_model_output_is_logged_and_executes_nothing(recorder):
    browser = FakeBrowser()
    result = run(browser, [PolicyError("invalid")], recorder)
    assert result["outcome"] == "JEV_FAILED"
    assert browser.acts == []
    assert len(recorder.calls) == 1


def test_budget_stops_the_attempt(recorder):
    wait = Decision("WAIT", {"id": "wait", "kind": "wait", "label": "Wait"})
    result = run(FakeBrowser(), [wait] * 5, recorder, budget=Budget(max_actions=2))
    assert result["outcome"] == "ATTEMPT_BUDGET"
    assert result["actions"] == 2


def test_three_unchanged_pages_are_stuck(recorder):
    class Static(FakeBrowser):
        def observe(self):
            return page("same")

    result = run(Static(), [Decision("CLICK", CLICK)] * 3, recorder)
    assert result["outcome"] == "STUCK"


def test_a_value_chosen_by_jev_is_typed_and_a_missing_one_types_nothing(recorder):
    browser = FakeBrowser()
    result = run(browser, [Decision("TYPE_TEXT", FILL, text="Lisbon"), Decision("TYPE_TEXT", FILL)], recorder)
    assert browser.acts == [("e1", "Lisbon")]
    assert result["outcome"] == "NEEDS_VALUE"
    assert result["field"]["label"] == "Destination"


def test_history_is_extended_in_place_with_the_attempt(recorder):
    history = [{"attempt": 1, "kind": "click", "page_changed": False}] * 3
    plan = {**PLAN, "attempt": 2}
    result = run_agent(
        FakeBrowser(), FakePolicy([Decision("CLICK", CLICK), Decision("DONE")]), plan, recorder, history=history
    )
    assert result["outcome"] == "GOAL_REPORTED"  # Attempt 1 being stuck does not stop attempt 2.
    assert history[-1]["attempt"] == 2


def test_a_target_jev_cannot_see_runs_nothing_and_is_noted(recorder):
    browser = FakeBrowser()
    missing = Decision("NOT_VISIBLE", wanted="CLICK")
    history = []
    result = run_agent(
        browser, FakePolicy([missing, Decision("CLICK", CLICK), Decision("DONE")]), PLAN, recorder, history=history
    )
    assert result["outcome"] == "GOAL_REPORTED"
    assert browser.acts == [("e2", None)]
    assert history[0]["kind"] == "missing" and history[0]["page_changed"] is False
    assert result["actions"] == 1  # Not counted against the budget.


def test_three_targets_jev_cannot_see_are_stuck(recorder):
    missing = Decision("NOT_VISIBLE", wanted="CLICK")
    result = run(FakeBrowser(), [missing] * 3, recorder)
    assert result["outcome"] == "STUCK"
