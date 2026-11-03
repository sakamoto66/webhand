"""The role split across separate CLI calls, on real Chrome. Jev is replaced; no paid API."""

import copy
import json
from pathlib import Path

import pytest

from webhand import cli, runbook, session
from webhand.policies.base import action_space, model_state, resolve, value_choices
from webhand.types import Decision, ModelCall


class ScriptedJev:
    """Plays Jev: chooses from the observed page and records the plan and state it was given.

    A move is (operation, element label, value label). The value label picks one of Claude's
    values by its label, as Jev picks a value number; None means no value fits.
    """

    name = "jev"
    moves: list = []
    plans: list = []
    states: list = []

    def __init__(self):
        self.calls = []

    def choose(self, page, plan, history):
        self.plans.append(copy.deepcopy(plan))
        self.states.append(model_state(page, history, plan))
        self.calls.append(ModelCall("typesafe", "jev", "choose", 1, 10, 1))
        operation, label, value = self.moves.pop(0)
        if label is None:
            return Decision(operation, confidence=0.9)
        _, targets, _ = action_space(page["actions"])
        index = next(i for i, a in targets[operation].items() if label in a["label"])
        decision = resolve(page, operation, index)
        decision.confidence = 0.9
        if operation == "TYPE_TEXT" and value is not None:
            decision.text = next(v["value"] for v in value_choices(plan).values() if v["label"] == value)
        return decision


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("WEBHAND_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("WEBHAND_LOG", str(tmp_path / "run.jsonl"))
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(runbook, "root", lambda: Path(__file__).parents[1] / "runbooks")
    monkeypatch.setattr(cli, "JevPolicy", ScriptedJev)
    ScriptedJev.moves, ScriptedJev.plans, ScriptedJev.states = [], [], []
    yield
    state = session.load()
    if state:
        session.stop_chrome(state)
        session.clear()


def events(tmp_path):
    return [json.loads(line) for line in (tmp_path / "run.jsonl").read_text().splitlines()]


def begin(*options):
    assert (
        cli.main(
            [
                "start",
                "--task",
                "hotel_filter",
                "--chrome",
                "linux",
                "--step",
                "Search for Lisbon",
                "--step",
                "Open Casa Flora",
                "--value",
                "Destination=Lisbon",
                *options,
            ]
        )
        == cli.OK
    )


FULL = [
    ("TYPE_TEXT", "Destination", "Destination"),
    ("CLICK", "Find stays", None),
    ("SELECT", "Design", None),
    ("CLICK", "Free cancellation", None),
    ("CLICK", "View Casa Flora", None),
    ("DONE", None, None),
]


def test_jev_runs_to_the_goal_in_one_call_and_verification_passes(tmp_path, capsys):
    begin()
    ScriptedJev.moves = list(FULL)
    capsys.readouterr()
    assert cli.main(["run"]) == cli.OK
    output = capsys.readouterr().out
    assert "OUTCOME GOAL_REPORTED (attempt 1/3)" in output
    history = session.load()["history"]
    assert [(s["operation"], s["decided_by"], s["text"]) for s in history][:2] == [
        ("TYPE_TEXT", "jev", "Lisbon"),
        ("CLICK", "jev", None),
    ]
    cli.main(["finish", "--status", "done"])
    assert session.load() is None
    end = events(tmp_path)[-1]
    assert end["verified"] is True
    assert end["escalations"] == {"GOAL_REPORTED": 1}
    assert end["decided_by"] == {"jev": 5}
    assert end["attempts"] == 1
    assert end["providers"]["typesafe"]["calls"] == 6
    assert end["handoffs"] > 0 and end["handoff_chars"] > 0


def test_jev_sees_the_goal_plan_page_and_full_history():
    begin()
    ScriptedJev.moves = [("CLICK", "Free cancellation", None), ("DONE", None, None)]
    cli.main(["run"])
    state = ScriptedJev.states[-1]
    assert state["plan"]["goal"].startswith("Find a stay in Lisbon")
    assert state["plan"]["steps"] == ["1. Search for Lisbon", "2. Open Casa Flora"]
    assert state["page"]["url"].endswith("hotel.html?scenario=travel")
    assert [h["action"] for h in state["action_history"]] == ["Free cancellation"]


def test_a_field_without_a_fitting_value_returns_to_claude(capsys):
    begin()
    ScriptedJev.moves = [("TYPE_TEXT", "Destination", None)]
    capsys.readouterr()
    cli.main(["run"])
    output = capsys.readouterr().out
    assert "OUTCOME NEEDS_VALUE" in output
    assert "ELEMENTS:" not in output  # Value handoffs stay small.
    assert session.load()["history"] == []
    assert cli.main(["run"]) == cli.FAILED
    ScriptedJev.moves = [("TYPE_TEXT", "Destination", "City"), ("DONE", None, None)]
    assert cli.main(["run", "--value", "City=Porto"]) == cli.OK
    assert session.load()["history"][0]["text"] == "Porto"


def test_a_person_acts_while_nothing_else_does(tmp_path, capsys):
    begin()
    ScriptedJev.moves = [("NEEDS_HUMAN", None, None)]
    capsys.readouterr()
    cli.main(["run"])
    assert "OUTCOME NEEDS_HUMAN" in capsys.readouterr().out
    assert cli.main(["run"]) == cli.FAILED
    assert cli.main(["act", "WAIT"]) == cli.FAILED
    ScriptedJev.moves = [("DONE", None, None)]
    assert cli.main(["run", "--human-done"]) == cli.OK
    assert ScriptedJev.states[-1]["action_history"][-1]["kind"] == "human"
    statuses = [e["status"] for e in events(tmp_path) if e["type"] == "human_step"]
    assert statuses == ["requested", "done"]


def test_person_steps_need_a_visible_window():
    with pytest.raises(SystemExit, match="--headed"):
        cli.main(["start", "--task", "hotel_filter", "--chrome", "linux", "--step", "[person] Sign in"])
    assert session.load() is None


def test_stuck_attempt_is_replanned_from_the_start_url(tmp_path, capsys):
    begin()
    state = session.load()
    state["history"] = [
        {
            "step": i,
            "attempt": 1,
            "kind": "click",
            "operation": "CLICK",
            "action": "Find stays",
            "text": None,
            "url": "u",
            "page_changed": False,
        }
        for i in (1, 2, 3)
    ]
    session.save(state)
    cli.main(["run"])
    assert ScriptedJev.states == []  # Stuck is detected before Jev is asked.
    assert session.load()["outcome"] == "STUCK"
    assert cli.main(["run"]) == cli.FAILED
    capsys.readouterr()
    assert cli.main(["replan", "--reason", "Search did nothing; type first", "--restart"]) == cli.OK
    assert "ATTEMPT 2/3" in capsys.readouterr().out
    ScriptedJev.moves = list(FULL)
    cli.main(["run"])
    plan = ScriptedJev.plans[-1]
    assert plan["attempt"] == 2
    assert plan["notes"] == ["Attempt 1 ended with STUCK. Claude: Search did nothing; type first"]
    assert ScriptedJev.states[0]["action_history"][0]["attempt"] == 1  # Earlier attempts stay visible.
    cli.main(["finish", "--status", "done"])
    end = events(tmp_path)[-1]
    assert (end["verified"], end["attempts"]) == (True, 2)
    assert [o["outcome"] for o in end["attempt_outcomes"]] == ["STUCK", "GOAL_REPORTED"]


def test_replanning_stops_at_the_attempt_limit():
    begin("--max-attempts", "2")
    assert cli.main(["replan", "--reason", "x"]) == cli.OK
    assert cli.main(["replan", "--reason", "y"]) == cli.BUDGET


def test_replan_can_replace_steps_and_values():
    begin()
    cli.main(["replan", "--reason", "x", "--step", "A different step", "--value", "Destination=Porto"])
    plan = session.load()["plan"]
    assert [s["instruction"] for s in plan["steps"]] == ["A different step"]
    assert plan["values"] == [{"label": "Destination", "value": "Porto"}]


def test_an_uncertain_action_cannot_be_replanned():
    begin()
    state = session.load()
    state["outcome"] = "UNCERTAIN"
    session.save(state)
    assert cli.main(["replan", "--reason", "x"]) == cli.UNCERTAIN
    assert cli.main(["run"]) == cli.UNCERTAIN


def test_claude_override_lets_jev_continue_the_attempt():
    begin()
    ScriptedJev.moves = [("BLOCKED", None, None)]
    cli.main(["run"])
    _, targets, _ = action_space(session.load()["page"]["actions"])
    index = next(i for i, a in targets["CLICK"].items() if "Free cancellation" in a["label"])
    assert cli.main(["act", "CLICK", index]) == cli.OK
    state = session.load()
    assert state["outcome"] is None
    assert [(s["decided_by"], s["action"]) for s in state["history"]] == [("claude", "Free cancellation")]


def test_attempt_budget_returns_to_claude(capsys):
    begin("--max-actions", "1")
    ScriptedJev.moves = [("CLICK", "Free cancellation", None)]
    capsys.readouterr()
    cli.main(["run"])
    assert "OUTCOME ATTEMPT_BUDGET" in capsys.readouterr().out
    assert cli.main(["act", "WAIT"]) == cli.BUDGET


def test_claimed_done_does_not_pass_verification(tmp_path):
    cli.main(["start", "--task", "hotel_filter", "--chrome", "linux"])
    cli.main(["finish", "--status", "done"])
    end = events(tmp_path)[-1]
    assert (end["status"], end["verified"]) == ("done", False)


def test_invalid_override_is_rejected_without_a_step():
    begin()
    assert cli.main(["act", "CLICK", "999"]) == cli.FAILED
    assert session.load()["history"] == []


def test_missing_jev_key_is_reported_before_chrome_starts(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY")
    with pytest.raises(SystemExit):
        cli.main(["start", "--task", "hotel_filter", "--chrome", "linux"])
    assert session.load() is None


def test_a_new_session_uses_a_temporary_profile():
    cli.main(["start", "--task", "hotel_filter", "--chrome", "linux"])
    state = session.load()
    assert Path(state["profile"]).name.startswith("webhand-")
    cli.main(["finish", "--status", "abandoned"])
    assert not Path(state["profile"]).exists()


def test_a_saved_profile_keeps_its_sign_in_between_runs(tmp_path):
    page = tmp_path / "site.html"
    page.write_text("<title>Site</title><h1>Site</h1>")
    url = page.as_uri()
    options = ["--goal", "Open the site", "--url", url, "--chrome", "linux", "--session", "profile:demo"]
    cli.main(["start", *options])
    from webhand.browser import Browser

    browser = Browser(port=session.load()["port"])
    browser.context.add_cookies(
        [{"name": "signed_in", "value": "yes", "url": "https://example.test/", "expires": 2_000_000_000}]
    )
    browser.close()
    profile = session.load()["profile"]
    cli.main(["finish", "--status", "abandoned"])
    assert Path(profile).is_dir()

    cli.main(["start", *options])
    browser = Browser(port=session.load()["port"])
    cookies = browser.context.cookies("https://example.test/")
    browser.close()
    assert [c["value"] for c in cookies if c["name"] == "signed_in"] == ["yes"]
    assert session.load()["profile"] == profile


def test_a_task_keeps_its_own_goal():
    with pytest.raises(SystemExit, match="own goal"):
        cli.main(["start", "--task", "hotel_filter", "--goal", "Something else"])


def test_catalog_lists_learned_services_and_procedures(capsys):
    assert cli.main(["catalog", "--chrome", "linux"]) == cli.OK
    output = capsys.readouterr().out
    assert "SERVICE hotel-site" in output
    assert "PROCEDURE hotel-site/reserve [" in output
    assert "param check_in:" in output
    assert "SAVED PROFILES: (none)" in output


def test_claude_chooses_regions_and_jev_sees_the_outline(tmp_path, capsys):
    begin("--focus", "form", "--skip", "header")
    output = capsys.readouterr().out
    assert "FOCUS: form" in output and "SKIP: header" in output
    ScriptedJev.moves = [("BLOCKED", None, None)]
    cli.main(["run"])
    state = ScriptedJev.states[0]
    outline = {region["key"]: region for region in state["page"]["regions"]}
    assert outline["header/nav"]["view"] == "skip"
    assert any(region.get("view") == "focus" for region in outline.values())
    assert "REGIONS (shown/all" in capsys.readouterr().out
    start = next(e for e in events(tmp_path) if e["type"] == "run_start")
    assert start["view"] == {"focus": ["form"], "skip": ["header"]}


def test_replan_replaces_claudes_regions():
    begin("--focus", "form")
    cli.main(["replan", "--reason", "The filter is in the header", "--focus", "header"])
    state = session.load()
    assert state["view"] == {"focus": ["header"], "skip": []}
    assert any(region.get("view") == "focus" for region in state["page"]["regions"])
