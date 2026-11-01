"""Shared data shapes. Pages and actions are the plain dicts produced by snapshot.js."""

from dataclasses import dataclass
from typing import Any, Protocol

Page = dict[str, Any]
Action = dict[str, Any]


class PolicyError(RuntimeError):
    """The model gave no usable decision. Nothing was executed."""


class StalePage(ValueError):
    """A decision no longer refers to the observed page. Nothing was executed."""


class MutationUncertain(RuntimeError):
    """A browser mutation may have happened. It must never be retried."""


@dataclass
class ModelCall:
    provider: str
    model: str
    purpose: str  # "choose" or "text"
    latency_ms: int
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass
class Decision:
    operation: str
    action: Action | None = None  # None only for DONE and BLOCKED
    confidence: float | None = None  # Lowest confidence behind this choice, when the chooser reports one


class Policy(Protocol):
    name: str
    calls: list[ModelCall]  # Appended before validation, so rejected responses are still logged.

    def config(self) -> dict: ...

    def choose(self, page: Page, goal: str, history: list[dict]) -> Decision: ...

    def text(self, context: dict) -> str: ...
