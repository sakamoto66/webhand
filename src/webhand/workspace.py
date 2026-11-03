"""Where webhand keeps what it learns and does: $WEBHAND_HOME, or ~/.webhand.

runbooks/  service information and runbooks
runs/      run logs, which hold page text
state/     the active session and saved profiles
.env       TYPESAFE_API_KEY and TYPESAFE_MODEL
"""

import os
from pathlib import Path


def home() -> Path:
    return Path(os.environ.get("WEBHAND_HOME") or Path.home() / ".webhand").expanduser()


def load_env() -> None:
    """Reads home()/.env. Variables already set win."""
    file = home() / ".env"
    if not file.is_file():
        return
    for line in file.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.strip().removeprefix("export ").partition("=")
        if sep and key and not key.startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))
