"""Fixed steps from the task file. No API. It tests the harness, not an agent."""

from ..types import Decision, ModelCall, Page, PolicyError
from .base import OPERATIONS, action_space, resolve


class ScriptedPolicy:
    """A step advances only once its action reaches the history.

    A stale page means nothing happened, so the same step is chosen again on the fresh page.
    A step without a label is a control such as SCROLL_UP or WAIT.
    """

    name = "scripted"

    def __init__(self, script: list[dict]):
        self.script = script
        self.position = 0
        self.pending: int | None = None  # history length when the current step was chosen
        self.calls: list[ModelCall] = []

    def config(self) -> dict:
        return {"chooser": "scripted"}

    def choose(self, page: Page, plan: dict, history: list[dict]) -> Decision:
        if self.pending is not None and len(history) > self.pending:
            self.position += 1
        self.pending = None
        if self.position >= len(self.script):
            return Decision("DONE")
        step = self.script[self.position]
        if step["operation"] not in OPERATIONS.values():
            self.pending = len(history)
            return resolve(page, step["operation"], None)
        kind = {value: key for key, value in OPERATIONS.items()}[step["operation"]]
        _, targets, controls = action_space(page["actions"])
        for target, action in targets.get(step["operation"], {}).items():
            if action["kind"] == kind and step["label"] in action["label"]:
                self.pending = len(history)
                decision = resolve(page, step["operation"], target)
                decision.text = step.get("text")
                return decision
        if "SCROLL_DOWN" in controls:
            return resolve(page, "SCROLL_DOWN", None)
        raise PolicyError(f"Scripted step not found: {step}")
