"""Jev's role: choose the next operation and target inside the step Claude assigned.

Adapted from jev-ultrafast (MIT); see THIRD_PARTY_LICENSE_jev-ultrafast.txt.
"""

import math
import os
import time

import httpx

from ..types import Decision, ModelCall, Page, PolicyError
from .base import NEXT_ACTION, OPERATION_HELP, TARGET, TERMINAL_HELP, action_space, model_state, resolve

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


def build_questions(goal: str, targets: dict, controls: dict) -> tuple[dict, dict]:
    operations = {key: OPERATION_HELP[key] for key in targets}
    operations.update({key: value["label"] for key, value in controls.items()})
    operations.update(TERMINAL_HELP)
    questions = {
        "operation": {"type": "choice", "criteria": operations, "instructions": {"goal": goal, "rules": NEXT_ACTION}}
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
            },
            "instructions": {"goal": goal, "operation": operation, "rules": [NEXT_ACTION, TARGET]},
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

    def choose(self, page: Page, goal: str, history: list[dict]) -> Decision:
        _, targets, controls = action_space(page["actions"])
        questions, operations = build_questions(goal, targets, controls)
        body = {"model": self.model, "state": model_state(page, history), "questions": questions}
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
            target_answer = validate_choice(answers.get(operation.lower() + "_target", {}), targets[operation])
            target = target_answer["choice"]
            confidences.append(target_answer["confidence"])
        decision = resolve(page, operation, target)
        decision.confidence = min(confidences)
        return decision
