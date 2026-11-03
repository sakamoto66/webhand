"""Append-only run logs and token cost. Every line is flushed so a crashed run keeps its data."""

import json
import subprocess
from dataclasses import asdict
from pathlib import Path

from .types import ModelCall


def summarize(calls: list[ModelCall]) -> dict:
    """Token totals per provider."""
    providers: dict[str, dict] = {}
    for call in calls:
        total = providers.setdefault(
            call.provider,
            {"calls": 0, "input_tokens": 0, "output_tokens": 0},
        )
        total["calls"] += 1
        total["input_tokens"] += call.input_tokens or 0
        total["output_tokens"] += call.output_tokens or 0
    return {"providers": providers}


def git_state() -> dict:
    def git(*args):
        result = subprocess.run(["git", *args], capture_output=True, text=True)
        return result.stdout.strip() if result.returncode == 0 else None

    return {"commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain"))}


class Recorder:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.file = path.open("a", encoding="utf-8")
        self.calls: list[ModelCall] = []

    def event(self, event_type: str, /, **fields) -> None:
        self.file.write(json.dumps({"type": event_type, **fields}, ensure_ascii=False) + "\n")
        self.file.flush()

    def call(self, call: ModelCall) -> None:
        self.calls.append(call)
        self.event("call", **asdict(call))

    def close(self) -> None:
        self.file.close()
