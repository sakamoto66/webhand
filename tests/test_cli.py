"""The role split across separate CLI calls, on real Chrome. Jev is replaced; no paid API."""

import json
from pathlib import Path

import pytest

from browser_lab import cli, session
from browser_lab.policies.base import action_space, resolve
from browser_lab.types import Decision, ModelCall


class ScriptedJev:
    """Plays Jev: chooses from the observed page and records the goal text it was given."""

    moves: list = []
    goals: list = []

    def __init__(self):
        self.calls = []

    def choose(self, page, goal, _history):
        self.goals.append(goal)
        self.calls.append(ModelCall("typesafe", "jev", "choose", 1, 10, 1))
        operation, label, confidence = self.moves.pop(0)
        if label is None:
            return Decision(operation, confidence=confidence)
        _, targets, _ = action_space(page["actions"])
        index = next(i for i, a in targets[operation].items() if label in a["label"])
        decision = resolve(page, operation, index)
        decision.confidence = confidence
        return decision


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSER_LAB_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("BROWSER_LAB_LOG", str(tmp_path / "run.jsonl"))
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(cli, "JevPolicy", ScriptedJev)
    ScriptedJev.moves, ScriptedJev.goals = [], []
    yield
    state = session.load()
    if state:
        session.stop_chrome(state)
        session.clear()


def events(tmp_path):
    return [json.loads(line) for line in (tmp_path / "run.jsonl").read_text().splitlines()]


def begin(*options):
    cli.main(["start", "--task", "hotel_filter", *options])
    cli.main(["plan", "Search for Lisbon", "Open Casa Flora"])


def test_advance_requires_a_plan_from_claude():
    cli.main(["start", "--task", "hotel_filter"])
    assert cli.main(["advance"]) == cli.FAILED


def test_jev_acts_alone_until_text_is_needed(tmp_path, capsys):
    begin()
    ScriptedJev.moves = [("CLICK", "Free cancellation", 0.9), ("TYPE_TEXT", "Destination", 0.9), ("DONE", None, 0.9)]
    capsys.readouterr()
    assert cli.main(["advance"]) == cli.OK
    output = capsys.readouterr().out
    assert "ESCALATION NEEDS_TEXT" in output
    assert "ELEMENTS:" not in output  # Text handoffs stay small.
    assert cli.main(["advance"]) == cli.FAILED
    assert cli.main(["advance", "--text", "Lisbon"]) == cli.OK
    assert "ESCALATION STEP_DONE" in capsys.readouterr().out
    steps = session.load()["history"]
    assert [(s["operation"], s["decided_by"], s["text"]) for s in steps] == [
        ("CLICK", "jev", None),
        ("TYPE_TEXT", "jev", "Lisbon"),
    ]


def test_jev_is_scoped_to_the_current_step():
    begin()
    ScriptedJev.moves = [("DONE", None, 0.9), ("DONE", None, 0.9)]
    cli.main(["advance"])
    assert ScriptedJev.goals[0].startswith("Current step: Search for Lisbon")
    cli.main(["advance", "--next"])
    assert ScriptedJev.goals[1].startswith("Current step: Open Casa Flora")


def test_jev_done_does_not_move_the_plan_without_claude():
    begin()
    ScriptedJev.moves = [("DONE", None, 0.9)]
    cli.main(["advance"])
    assert session.load()["step_index"] == 0


def test_low_confidence_waits_for_claude(capsys):
    begin()
    ScriptedJev.moves = [("CLICK", "Find stays", 0.2), ("DONE", None, 0.9)]
    capsys.readouterr()
    cli.main(["advance"])
    output = capsys.readouterr().out
    assert "ESCALATION LOW_CONFIDENCE" in output
    assert "Find stays" in output
    assert session.load()["history"] == []
    assert cli.main(["advance"]) == cli.FAILED
    cli.main(["advance", "--accept"])
    assert len(session.load()["history"]) == 1


def test_claude_override_replaces_the_proposal():
    begin()
    ScriptedJev.moves = [("CLICK", "Find stays", 0.2)]
    cli.main(["advance"])
    _, targets, _ = action_space(session.load()["page"]["actions"])
    index = next(i for i, a in targets["CLICK"].items() if "Free cancellation" in a["label"])
    assert cli.main(["act", "CLICK", index]) == cli.OK
    state = session.load()
    assert state["pending"] is None
    assert [(s["decided_by"], s["action"]) for s in state["history"]] == [("claude", "Free cancellation")]


def test_threshold_is_configurable():
    begin("--min-confidence", "0.1")
    ScriptedJev.moves = [("CLICK", "Find stays", 0.2), ("DONE", None, 0.9)]
    cli.main(["advance"])
    assert session.load()["history"][0]["confidence"] == 0.2


def test_stuck_jev_escalates_instead_of_looping(tmp_path, capsys):
    begin()
    state = session.load()
    state["history"] = [{"page_changed": False, "kind": "click"}] * 3
    session.save(state)
    capsys.readouterr()
    cli.main(["advance"])
    assert "ESCALATION STUCK" in capsys.readouterr().out
    assert ScriptedJev.goals == []


def test_all_steps_confirmed_then_claude_finishes(capsys):
    begin()
    ScriptedJev.moves = [("DONE", None, 0.9), ("DONE", None, 0.9)]
    cli.main(["advance"])
    cli.main(["advance", "--next"])
    capsys.readouterr()
    cli.main(["advance", "--next"])
    assert "ALL STEPS CONFIRMED" in capsys.readouterr().out
    assert session.load() is not None


def test_replanning_replaces_steps_and_drops_a_pending_proposal():
    begin()
    ScriptedJev.moves = [("CLICK", "Find stays", 0.2)]
    cli.main(["advance"])
    cli.main(["plan", "A different step"])
    state = session.load()
    assert (state["plan"], state["step_index"], state["pending"]) == (["A different step"], 0, None)


def test_full_run_passes_independent_verification_and_logs_the_split(tmp_path):
    begin()
    ScriptedJev.moves = [
        ("TYPE_TEXT", "Destination", 0.9),
        ("CLICK", "Find stays", 0.9),
        ("SELECT", "Design", 0.9),
        ("CLICK", "Free cancellation", 0.9),
        ("DONE", None, 0.9),
    ]
    cli.main(["advance"])
    cli.main(["advance", "--text", "Lisbon"])
    ScriptedJev.moves = [("CLICK", "View Casa Flora", 0.9), ("DONE", None, 0.9)]
    cli.main(["advance", "--next"])
    cli.main(["finish", "--status", "done"])
    assert session.load() is None
    end = events(tmp_path)[-1]
    assert end["verified"] is True
    assert end["escalations"] == {"NEEDS_TEXT": 1, "STEP_DONE": 2}
    assert end["decided_by"] == {"jev": 5}
    assert end["providers"]["typesafe"]["calls"] == 7
    assert end["handoffs"] > 0 and end["handoff_chars"] > 0


def test_claimed_done_does_not_pass_verification(tmp_path):
    cli.main(["start", "--task", "hotel_filter"])
    cli.main(["finish", "--status", "done"])
    end = events(tmp_path)[-1]
    assert (end["status"], end["verified"]) == ("done", False)


def test_invalid_override_is_rejected_without_a_step():
    begin()
    assert cli.main(["act", "CLICK", "999"]) == cli.FAILED
    assert session.load()["history"] == []


def test_budget_stops_both_roles():
    begin("--max-actions", "0")
    assert cli.main(["act", "WAIT"]) == cli.BUDGET
    assert cli.main(["advance"]) == cli.BUDGET


def test_missing_jev_key_is_reported_before_chrome_starts(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY")
    with pytest.raises(SystemExit):
        cli.main(["start", "--task", "hotel_filter"])
    assert session.load() is None


def test_session_chrome_uses_a_temporary_profile():
    cli.main(["start", "--task", "hotel_filter"])
    state = session.load()
    assert Path(state["profile"]).name.startswith("browser-lab-")
    cli.main(["finish", "--status", "abandoned"])
    assert not Path(state["profile"]).exists()
