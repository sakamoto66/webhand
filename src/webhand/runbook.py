"""What webhand has learned: service information and reviewed procedures (runbooks).

Both guide Claude's plan and Jev's choices. Procedures are never replayed.
"""

import hashlib
import re
import tomllib
from pathlib import Path
from urllib.parse import urlsplit

from . import workspace

NAME = re.compile(r"[\w-]+(/[\w-]+)?")
PARAM = re.compile(r"\{([A-Za-z_]\w*)\}")
ACTORS = {"jev", "human"}
STATUSES = {"draft", "approved"}
DEFAULTS = {"focus", "skip"}  # A region's default in service.toml. Without one, the region is observed as usual.
SERVICE_FILE = "service"  # runbooks/<service>/service.toml holds the service information, not a procedure.


def root() -> Path:
    return workspace.home() / "runbooks"


class RunbookError(ValueError):
    """The runbook cannot be used as written."""


def path(name: str) -> Path:
    if not NAME.fullmatch(name) or name.split("/")[-1] == SERVICE_FILE:
        raise RunbookError(f"Invalid runbook name: {name!r}")
    return root() / f"{name}.toml"


def service_path(service: str) -> Path:
    if not re.fullmatch(r"[\w-]+", service):
        raise RunbookError(f"Invalid service name: {service!r}")
    return root() / service / f"{SERVICE_FILE}.toml"


def read_toml(file: Path) -> tuple[bytes, dict]:
    raw = file.read_bytes()
    try:
        return raw, tomllib.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise RunbookError(f"{file}: {error}") from error


def patterns(file: Path, where: str, value) -> list[str]:
    """Region patterns, such as "main/form:宿泊予約" or "footer". Anything else is an error."""
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise RunbookError(f"{file}: {where} must be a list of region keys")
    return [item.strip() for item in value]


def regions(file: Path, page: dict) -> list[dict]:
    found = []
    for region in page.get("regions", []):
        key = patterns(file, "pages.regions.key", [region.get("key")] if region.get("key") is not None else None)
        if not key:
            raise RunbookError(f"{file}: a region on {page.get('url', '?')} has no key")
        default = region.get("default")
        if default is not None and default not in DEFAULTS:
            raise RunbookError(f"{file}: region {key[0]!r} has unknown default {default!r}")
        found.append({"key": key[0], "purpose": region.get("purpose", ""), "default": default})
    return found


def view(*layers: dict | None) -> dict:
    """Combines region choices. A later layer wins: learned defaults, then the runbook, then Claude.

    Focus patterns keep the later layer's order first, since the first focus is shown first.
    """
    focus: list[str] = []
    skip: list[str] = []
    for layer in layers:
        if not layer:
            continue
        new_focus, new_skip = list(layer.get("focus", [])), list(layer.get("skip", []))
        focus = [*new_focus, *(p for p in focus if p not in new_focus and p not in new_skip)]
        skip = [*(p for p in skip if p not in new_focus and p not in new_skip), *new_skip]
    return {"focus": focus, "skip": skip}


def service_view(info: dict | None) -> dict:
    """What the service information says to focus on or skip on every page."""
    keys = [r for page in (info or {}).get("pages", []) for r in page.get("regions", [])]
    return {
        "focus": [r["key"] for r in keys if r["default"] == "focus"],
        "skip": [r["key"] for r in keys if r["default"] == "skip"],
    }


def load_service(service: str) -> dict | None:
    """Service information for Claude's plan and Jev's state. None when nothing was learned."""
    file = service_path(service)
    if not file.is_file():
        return None
    _, data = read_toml(file)
    missing = [key for key in ("service", "description", "base_url", "sources") if not data.get(key)]
    if missing:
        raise RunbookError(f"{file}: missing {', '.join(missing)}")
    login = data.get("login", {})
    return {
        "service": data["service"],
        "description": data["description"].strip(),
        "base_url": data["base_url"],
        "login": {"required": bool(login.get("required")), "url": login.get("url")},
        "pages": [
            {"url": p.get("url", ""), "purpose": p.get("purpose", ""), "regions": regions(file, p)}
            for p in data.get("pages", [])
        ],
        "facts": [str(fact) for fact in data.get("facts", [])],
    }


def catalog() -> list[dict]:
    """Everything learned, without filling parameters. Claude reads this to plan."""
    services = []
    folders = sorted(p for p in root().iterdir() if p.is_dir()) if root().is_dir() else []
    for folder in folders:
        info = load_service(folder.name)
        procedures = []
        for file in sorted(folder.glob("*.toml")):
            if file.stem == SERVICE_FILE:
                continue
            _, data = read_toml(file)
            procedures.append(
                {
                    "name": f"{folder.name}/{file.stem}",
                    "status": data.get("status"),
                    "goal": data.get("goal"),
                    "start_url": data.get("start_url"),
                    "params": {k: v.get("description", "") for k, v in data.get("params", {}).items()},
                    "human_steps": sum(1 for s in data.get("steps", []) if s.get("actor") == "human"),
                    "focus": data.get("focus", []),
                    "skip": data.get("skip", []),
                }
            )
        services.append({"service": folder.name, "info": info, "procedures": procedures})
    return services


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
    raw, data = read_toml(file)

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
        "service": data["service"],
        "status": data["status"],
        "digest": hashlib.sha256(raw).hexdigest()[:16],
        "goal": fill(data["goal"]),
        "start_url": resolve_url(fill(data["start_url"])),
        "steps": steps,
        "focus": patterns(file, "focus", data.get("focus")),
        "skip": patterns(file, "skip", data.get("skip")),
    }
