"""Jev's role: choose the next operation, target, and value toward Claude's goal, one page at a time.

Adapted from jev-ultrafast (MIT); see THIRD_PARTY_LICENSE_jev-ultrafast.txt.
"""

import math
import os
import time

import httpx

from ..types import Decision, ModelCall, Page, PolicyError
from .base import (
    NEXT_ACTION,
    NOT_VISIBLE,
    NOT_VISIBLE_HELP,
    OPERATION_HELP,
    TARGET,
    TERMINAL_HELP,
    VALUE,
    action_space,
    model_state,
    plan_text,
    resolve,
    value_choices,
)

URL = "https://api.typesafe.ai/v1/systemone"


def post_json(client: httpx.Client, key: str, body: dict) -> dict:
    for attempt in range(3):
        try:
            response = client.post(URL, json=body, headers={"Authorization": f"Bearer {key}"})
        except httpx.HTTPError:
            raise PolicyError("Jev connection failed; no action executed.") from None
        if response.status_code in {429, 503, 529} and attempt < 2:
            time.sleep(0.5 * 2**attempt)
            continue
        if response.is_error:
            raise PolicyError(f"Jev returned HTTP {response.status_code}; no action executed.")
        return response.json()
    raise PolicyError("Jev unavailable; no action executed.")


def validate_choice(answer, ids) -> dict:
    try:
        probabilities = answer["probabilities"]
        numbers = [*probabilities.values(), answer["confidence"]]
        valid = (
            answer["choice"] in ids
            and set(probabilities) == set(ids)
            and all(type(n) in (int, float) and math.isfinite(n) and 0 <= n <= 1 for n in numbers)
            and abs(sum(probabilities.values()) - 1) < 0.02
            and probabilities[answer["choice"]] >= max(probabilities.values()) - 1e-6
        )
    except (KeyError, TypeError, ValueError):
        valid = False
    if not valid:
        raise PolicyError("Invalid Jev response; no action executed.")
    return answer


NO_VALUE = "NONE"


def task_brief(plan: dict) -> dict:
    """Claude's plan travels with every question, not only in the state."""
    brief = {"goal": plan["goal"]}
    if plan.get("steps"):
        brief["plan"] = plan_text(plan)
    if plan.get("notes"):
        brief["notes_from_earlier_attempts"] = plan["notes"]
    return brief


def build_questions(plan: dict, targets: dict, controls: dict, values: dict) -> tuple[dict, dict]:
    brief = task_brief(plan)
    operations = {key: OPERATION_HELP[key] for key in targets}
    operations.update({key: value["label"] for key, value in controls.items()})
    operations.update(TERMINAL_HELP)
    questions = {
        "operation": {"type": "choice", "criteria": operations, "instructions": {**brief, "rules": NEXT_ACTION}}
    }
    for operation, candidates in targets.items():
        questions[operation.lower() + "_target"] = {
            "type": "choice",
            "criteria": {
                index: {
                    "element": f"[{index}] {a['label']}",
                    "current_value": a.get("current_value", a.get("value", "")),
                    **{k: a[k] for k in ("role", "checked", "selected", "expanded") if k in a},
                }
                for index, a in candidates.items()
            }
            | {NOT_VISIBLE: NOT_VISIBLE_HELP},
            "instructions": {**brief, "operation": operation, "rules": [NEXT_ACTION, TARGET]},
        }
    if "TYPE_TEXT" in targets:
        criteria = {key: f"{v['label']}: {v['value']}" for key, v in values.items()}
        criteria[NO_VALUE] = "No listed value belongs in the field"
        questions["type_text_value"] = {
            "type": "choice",
            "criteria": criteria,
            "instructions": {**brief, "operation": "TYPE_TEXT", "rules": [VALUE]},
        }
    return questions, operations


class JevPolicy:
    name = "jev"

    def __init__(self, client=None):
        self.key = os.environ.get("TYPESAFE_API_KEY")
        if not self.key:
            raise PolicyError("TYPESAFE_API_KEY is not set.")
        self.model = os.environ.get("TYPESAFE_MODEL", "jev-latest")
        self.client = client or httpx.Client(http2=True, timeout=25)
        self.calls: list[ModelCall] = []
        self.served_model = None

    def config(self) -> dict:
        return {"chooser": self.served_model or self.model}

    def choose(self, page: Page, plan: dict, history: list[dict]) -> Decision:
        _, targets, controls = action_space(page["actions"])
        values = value_choices(plan)
        questions, operations = build_questions(plan, targets, controls, values)
        body = {"model": self.model, "state": model_state(page, history, plan), "questions": questions}
        started = time.perf_counter()
        result = post_json(self.client, self.key, body)
        usage = result.get("usage") or {}
        self.served_model = result.get("model", self.model)
        # The response carries token counts but no billed amount.
        self.calls.append(
            ModelCall(
                provider="typesafe",
                model=self.served_model,
                purpose="choose",
                latency_ms=round((time.perf_counter() - started) * 1000),
                input_tokens=usage.get("input_tokens", usage.get("prompt_tokens")),
                output_tokens=usage.get("output_tokens", usage.get("completion_tokens")),
            )
        )
        answers = result.get("answers", {})
        operation_answer = validate_choice(answers.get("operation", {}), operations)
        operation = operation_answer["choice"]
        confidences = [operation_answer["confidence"]]
        target = None
        if operation in targets:
            # Unused target heads cannot cause an action. Validate only the selected head.
            choices = {**targets[operation], NOT_VISIBLE: None}
            target_answer = validate_choice(answers.get(operation.lower() + "_target", {}), choices)
            target = target_answer["choice"]
            confidences.append(target_answer["confidence"])
            if target == NOT_VISIBLE:
                # Jev looked for a target it cannot see. Nothing runs; the loop asks again with this noted.
                return Decision(NOT_VISIBLE, confidence=min(confidences), wanted=operation)
        decision = resolve(page, operation, target)
        if operation == "TYPE_TEXT":
            value_answer = validate_choice(answers.get("type_text_value", {}), {**values, NO_VALUE: None})
            confidences.append(value_answer["confidence"])
            if value_answer["choice"] != NO_VALUE:
                decision.text = values[value_answer["choice"]]["value"]
        decision.confidence = min(confidences)
        return decision
