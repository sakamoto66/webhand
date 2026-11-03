"""Model contracts with stubbed transports. Tests must never call a paid API."""


import httpx
import pytest

from browser_lab.metrics import summarize
from browser_lab.policies.base import action_space, resolve
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
                    "BLOCKED": 0.0,
                },
            },
            "click_target": {
                "choice": "2",
                "confidence": 0.9,
                "probabilities": {"1": 0.0, "2": 1.0},
            },
        },
    }


def jev_policy(monkeypatch, handler):
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return JevPolicy(client=client)


def test_jev_records_tokens(monkeypatch):
    policy = jev_policy(monkeypatch, lambda _request: httpx.Response(200, json=jev_answer()))
    decision = policy.choose(PAGE, "goal", [])
    assert decision.action["id"] == "e3"
    call = policy.calls[0]
    assert (call.provider, call.input_tokens, call.output_tokens) == ("typesafe", 50, 5)
    assert decision.confidence == 0.9


def test_jev_invalid_target_is_rejected(monkeypatch):
    answer = jev_answer()
    answer["answers"]["click_target"]["choice"] = "99"
    policy = jev_policy(monkeypatch, lambda _request: httpx.Response(200, json=answer))
    with pytest.raises(PolicyError):
        policy.choose(PAGE, "goal", [])


def test_jev_http_error_is_a_policy_error(monkeypatch):
    policy = jev_policy(monkeypatch, lambda _request: httpx.Response(401))
    with pytest.raises(PolicyError):
        policy.choose(PAGE, "goal", [])


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
    assert policy.choose(PAGE, "goal", history).action["id"] == "e3"
    # The click raised StalePage, so nothing was recorded: the same step comes back.
    assert policy.choose(PAGE, "goal", history).action["id"] == "e3"
    history.append({"action": "Go"})
    decision = policy.choose(PAGE, "goal", history)
    assert decision.action["id"] == "e1"
    assert policy.text({}) == "Lisbon"
    history.append({"action": "City"})
    assert policy.choose(PAGE, "goal", history).operation == "DONE"


def test_scripted_control_step_without_a_label():
    policy = ScriptedPolicy([{"operation": "WAIT"}])
    assert policy.choose(PAGE, "goal", []).operation == "WAIT"
    with pytest.raises(PolicyError):
        ScriptedPolicy([{"operation": "SCROLL_UP"}]).choose(PAGE, "goal", [])
