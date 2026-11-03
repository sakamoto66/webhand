"""Runbooks: reviewed procedures for a service. They guide Claude and Jev; they are never replayed."""

import hashlib
import re
import tomllib
from pathlib import Path
from urllib.parse import urlsplit

NAME = re.compile(r"[\w-]+(/[\w-]+)?")
PARAM = re.compile(r"\{([A-Za-z_]\w*)\}")
ACTORS = {"jev", "human"}
STATUSES = {"draft", "approved"}


class RunbookError(ValueError):
    """The runbook cannot be used as written."""


def path(name: str) -> Path:
    if not NAME.fullmatch(name):
        raise RunbookError(f"Invalid runbook name: {name!r}")
    return Path("runbooks") / f"{name}.toml"


def parse_values(pairs: list[str]) -> dict[str, str]:
    values = {}
    for pair in pairs:
        key, separator, value = pair.partition("=")
        if not separator or not key:
            raise RunbookError(f"Expected KEY=VALUE, got {pair!r}")
        values[key] = value
    return values


def resolve_url(url: str) -> str:
    """A URL without a scheme is a local file, relative to the project root."""
    parts = urlsplit(url)
    if parts.scheme:
        return url
    file = Path(parts.path).resolve()
    if not file.is_file():
        raise RunbookError(f"start_url file not found: {parts.path}")
    return file.as_uri() + (f"?{parts.query}" if parts.query else "")


def load(name: str, values: dict[str, str] | None = None) -> dict:
    """Validates a runbook and fills in its parameters. Every problem is an error, not a guess."""
    file = path(name)
    if not file.is_file():
        raise RunbookError(f"Unknown runbook: {name}")
    raw = file.read_bytes()
    try:
        data = tomllib.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise RunbookError(f"{file}: {error}") from error

    required = ("service", "name", "goal", "start_url", "status", "sources", "steps")
    missing = [key for key in required if not data.get(key)]
    if missing:
        raise RunbookError(f"{file}: missing {', '.join(missing)}")
    if data["status"] not in STATUSES:
        raise RunbookError(f"{file}: unknown status {data['status']!r}")

    declared = data.get("params", {})
    supplied = dict(values or {})
    unknown = set(supplied) - set(declared)
    if unknown:
        raise RunbookError(f"{file}: unknown parameters {sorted(unknown)}")
    filled = {key: supplied.get(key, spec.get("default")) for key, spec in declared.items()}

    def fill(text: str) -> str:
        def replace(match: re.Match) -> str:
            value = filled.get(match[1])
            if value is None:
                raise RunbookError(f"{file}: parameter {match[1]!r} has no value. Pass --param {match[1]}=VALUE")
            return str(value)

        return PARAM.sub(replace, text)

    steps = []
    for number, step in enumerate(data["steps"], 1):
        actor = step.get("actor", "jev")
        if actor not in ACTORS:
            raise RunbookError(f"{file}: step {number} has unknown actor {actor!r}")
        if not step.get("instruction"):
            raise RunbookError(f"{file}: step {number} has no instruction")
        steps.append(
            {
                "actor": actor,
                "instruction": fill(step["instruction"]),
                "hints": [fill(hint) for hint in step.get("hints", [])],
                "done_when": fill(step["done_when"]) if step.get("done_when") else None,
            }
        )
    return {
        "name": name,
        "status": data["status"],
        "digest": hashlib.sha256(raw).hexdigest()[:16],
        "goal": fill(data["goal"]),
        "start_url": resolve_url(fill(data["start_url"])),
        "steps": steps,
    }
