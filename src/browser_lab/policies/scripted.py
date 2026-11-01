"""Fixed steps from the task file. No API. It tests the harness, not an agent."""

from ..types import Decision, ModelCall, Page, PolicyError
from .base import OPERATIONS, action_space, resolve


class ScriptedPolicy:
    name = "scripted"

    def __init__(self, script: list[dict]):
        self.script = script
        self.position = 0
        self.calls: list[ModelCall] = []

    def config(self) -> dict:
        return {"chooser": "scripted"}

    def text(self, context: dict) -> str:
        return self.script[self.position - 1]["text"]

    def choose(self, page: Page, goal: str, history: list[dict]) -> Decision:
        if self.position >= len(self.script):
            return Decision("DONE")
        step = self.script[self.position]
        kind = {value: key for key, value in OPERATIONS.items()}[step["operation"]]
        _, targets, controls = action_space(page["actions"])
        for target, action in targets.get(step["operation"], {}).items():
            if action["kind"] == kind and step["label"] in action["label"]:
                self.position += 1
                return resolve(page, step["operation"], target)
        if "SCROLL_DOWN" in controls:
            return resolve(page, "SCROLL_DOWN", None)
        raise PolicyError(f"Scripted step not found: {step}")
