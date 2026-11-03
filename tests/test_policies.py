"""Model contracts with stubbed transports. Tests must never call a paid API."""

import httpx
import pytest

from browser_lab.metrics import summarize
from browser_lab.policies.base import action_space, model_state, resolve
from browser_lab.policies.jev import JevPolicy, validate_choice
from browser_lab.policies.scripted import ScriptedPolicy
from browser_lab.types import ModelCall, PolicyError

PAGE = {
    "url": "http://local",
    "title": "T",
    "text": "text",
    "actions": [
        {"id": "e1", "kind": "fill", "node": 1, "role": "textbox", "label": "City", "value": ""},
        {"id": "e2", "kind": "click", "node": 1, "role": "textbox", "label": "Open City", "value": ""},
        {"id": "e3", "kind": "click", "node": 2, "role": "button", "label": "Go", "value": ""},
        {"id": "e4", "kind": "select", "node": 3, "role": "combobox", "label": "Kind → A", "value": "a"},
        {"id": "wait", "kind": "wait", "label": "Wait for the page to update"},
    ],
}


def test_action_space_uses_one_index_per_node():
    elements, targets, controls = action_space(PAGE["actions"])
    assert [e["index"] for e in elements] == ["1", "2", "3"]
    assert elements[0]["operations"] == ["TYPE_TEXT", "CLICK"]
    assert targets["SELECT"]["3:1"]["id"] == "e4"
    assert "WAIT" in controls


@pytest.mark.parametrize(
    "operation,target", [("CLICK", "99"), ("CLICK", None), ("TYPE_TEXT", "2"), ("SCROLL_DOWN", None), ("rm -rf", "1")]
)
def test_resolve_rejects_anything_unobserved(operation, target):
    with pytest.raises(PolicyError):
        resolve(PAGE, operation, target)


PLAN = {
    "goal": "goal",
    "steps": [{"instruction": "Go", "actor": "jev"}],
    "values": [{"label": "City", "value": "Lisbon"}],
}


def jev_answer():
    return {
        "model": "jev-1",
        "usage": {"input_tokens": 50, "output_tokens": 5},
        "answers": {
            "operation": {
                "choice": "CLICK",
                "confidence": 0.9,
                "probabilities": {
                    "TYPE_TEXT": 0.0,
                    "CLICK": 1.0,
                    "SELECT": 0.0,
                    "WAIT": 0.0,
                    "DONE": 0.0,
                    "NEEDS_HUMAN": 0.0,
                    "BLOCKED": 0.0,
                },
            },
            "click_target": {
                "choice": "2",
                "confidence": 0.9,
                "probabilities": {"1": 0.0, "2": 1.0, "NOT_VISIBLE": 0.0},
            },
        },
    }


def jev_policy(monkeypatch, handler):
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return JevPolicy(client=client)


def test_jev_records_tokens(monkeypatch):
    policy = jev_policy(monkeypatch, lambda _request: httpx.Response(200, json=jev_answer()))
    decision = policy.choose(PAGE, PLAN, [])
    assert decision.action["id"] == "e3"
    call = policy.calls[0]
    assert (call.provider, call.input_tokens, call.output_tokens) == ("typesafe", 50, 5)
    assert decision.confidence == 0.9


def test_jev_invalid_target_is_rejected(monkeypatch):
    answer = jev_answer()
    answer["answers"]["click_target"]["choice"] = "99"
    policy = jev_policy(monkeypatch, lambda _request: httpx.Response(200, json=answer))
    with pytest.raises(PolicyError):
        policy.choose(PAGE, PLAN, [])


def test_jev_http_error_is_a_policy_error(monkeypatch):
    policy = jev_policy(monkeypatch, lambda _request: httpx.Response(401))
    with pytest.raises(PolicyError):
        policy.choose(PAGE, PLAN, [])


def test_validate_choice_rejects_wrong_probabilities():
    with pytest.raises(PolicyError):
        validate_choice({"choice": "a", "confidence": 1, "probabilities": {"a": 0.1, "b": 0.9}}, {"a": 1, "b": 2})


def test_summary_totals_tokens_per_provider():
    calls = [ModelCall("typesafe", "j", "choose", 1, 20, 2), ModelCall("typesafe", "j", "choose", 1, None, None)]
    assert summarize(calls)["providers"]["typesafe"] == {"calls": 2, "input_tokens": 20, "output_tokens": 2}


def test_scripted_step_is_retried_until_it_reaches_the_history():
    policy = ScriptedPolicy(
        [{"operation": "CLICK", "label": "Go"}, {"operation": "TYPE_TEXT", "label": "City", "text": "Lisbon"}]
    )
    history = []
    assert policy.choose(PAGE, PLAN, history).action["id"] == "e3"
    # The click raised StalePage, so nothing was recorded: the same step comes back.
    assert policy.choose(PAGE, PLAN, history).action["id"] == "e3"
    history.append({"action": "Go"})
    decision = policy.choose(PAGE, PLAN, history)
    assert decision.action["id"] == "e1"
    assert decision.text == "Lisbon"
    history.append({"action": "City"})
    assert policy.choose(PAGE, PLAN, history).operation == "DONE"


def test_scripted_control_step_without_a_label():
    policy = ScriptedPolicy([{"operation": "WAIT"}])
    assert policy.choose(PAGE, PLAN, []).operation == "WAIT"
    with pytest.raises(PolicyError):
        ScriptedPolicy([{"operation": "SCROLL_UP"}]).choose(PAGE, PLAN, [])


def type_answer(value_choice):
    answer = jev_answer()
    ops = answer["answers"]["operation"]
    ops["choice"] = "TYPE_TEXT"
    ops["probabilities"] = {**{k: 0.0 for k in ops["probabilities"]}, "TYPE_TEXT": 1.0}
    answer["answers"]["type_text_target"] = {
        "choice": "1",
        "confidence": 0.8,
        "probabilities": {"1": 1.0, "NOT_VISIBLE": 0.0},
    }
    answer["answers"]["type_text_value"] = {
        "choice": value_choice,
        "confidence": 0.7,
        "probabilities": {"1": 1.0 if value_choice == "1" else 0.0, "NONE": 1.0 if value_choice == "NONE" else 0.0},
    }
    return answer


def test_jev_chooses_one_of_claudes_values_by_number(monkeypatch):
    sent = []

    def handler(request):
        sent.append(request)
        return httpx.Response(200, json=type_answer("1"))

    decision = jev_policy(monkeypatch, handler).choose(PAGE, PLAN, [])
    assert (decision.action["id"], decision.text, decision.confidence) == ("e1", "Lisbon", 0.7)
    import json

    body = json.loads(sent[0].content)
    assert body["questions"]["type_text_value"]["criteria"] == {
        "1": "City: Lisbon",
        "NONE": "No listed value belongs in the field",
    }
    assert body["state"]["plan"]["steps"] == ["1. Go"]
    assert "NEEDS_HUMAN" in body["questions"]["operation"]["criteria"]


def test_jev_choosing_no_value_leaves_the_text_empty(monkeypatch):
    decision = jev_policy(monkeypatch, lambda _r: httpx.Response(200, json=type_answer("NONE"))).choose(PAGE, PLAN, [])
    assert decision.operation == "TYPE_TEXT" and decision.text is None


def test_jev_cannot_invent_a_value(monkeypatch):
    answer = type_answer("1")
    answer["answers"]["type_text_value"]["choice"] = "Porto"
    with pytest.raises(PolicyError):
        jev_policy(monkeypatch, lambda _r: httpx.Response(200, json=answer)).choose(PAGE, PLAN, [])


def test_jev_is_told_how_much_of_the_page_is_offscreen():
    page = {**PAGE, "h": 780, "scroll": {"y": 444, "height": 1310}}
    assert model_state(page, [], PLAN)["page"]["offscreen"] == {"above_px": 444, "below_px": 86}
    top = {**PAGE, "h": 780, "scroll": {"y": 0, "height": 500}}
    assert model_state(top, [], PLAN)["page"]["offscreen"] == {"above_px": 0, "below_px": 0}


def test_jev_can_say_the_needed_target_is_not_visible(monkeypatch):
    answer = jev_answer()
    answer["answers"]["click_target"] = {
        "choice": "NOT_VISIBLE",
        "confidence": 0.8,
        "probabilities": {"1": 0.0, "2": 0.0, "NOT_VISIBLE": 1.0},
    }
    sent = []

    def handler(request):
        sent.append(request)
        return httpx.Response(200, json=answer)

    decision = jev_policy(monkeypatch, handler).choose(PAGE, PLAN, [])
    assert (decision.operation, decision.action, decision.wanted) == ("NOT_VISIBLE", None, "CLICK")
    import json

    criteria = json.loads(sent[0].content)["questions"]["click_target"]["criteria"]
    assert "NOT_VISIBLE" in criteria
