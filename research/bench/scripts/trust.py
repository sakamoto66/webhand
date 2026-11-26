"""Mark one evaluation folder as trusted in ~/.claude.json, so Claude Code does not ask on first launch.

Read-modify-write with an atomic rename, run just before claude starts in that folder.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

CONFIG = Path.home() / ".claude.json"


def main() -> None:
    folder = str(Path(sys.argv[1]).resolve())
    data = json.loads(CONFIG.read_text())
    project = data.setdefault("projects", {}).setdefault(folder, {})
    if project.get("hasTrustDialogAccepted"):
        return
    project["hasTrustDialogAccepted"] = True
    fd, tmp = tempfile.mkstemp(dir=CONFIG.parent, prefix=".claude.json.")
    with os.fdopen(fd, "w") as out:
        json.dump(data, out, indent=2)
    os.chmod(tmp, CONFIG.stat().st_mode & 0o777)
    os.replace(tmp, CONFIG)


if __name__ == "__main__":
    main()
