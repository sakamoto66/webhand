"""Check which webhand skill a session loaded: python check_skill.py bu2-001 EXPECTED_DIR

Claude Code writes "Base directory for this skill: <dir>" into the transcript when a skill loads.
Writes the directories found to work/<id>/skill_dir and exits 1 unless every one is EXPECTED_DIR.
"""

import re
import sys

from common import WORK, project_slug
from pathlib import Path

PATTERN = re.compile(r"Base directory for this skill: (\S+?)(?:\\n|\s|\")")


def main() -> None:
    task_id, expected = sys.argv[1], sys.argv[2].rstrip("/")
    work = WORK / task_id
    folder = Path.home() / ".claude" / "projects" / project_slug(work.resolve())
    found = sorted({m.rstrip("/") for p in folder.glob("*.jsonl") for m in PATTERN.findall(p.read_text())})
    (work / "skill_dir").write_text("\n".join(found) + "\n")
    if found and all(d == expected for d in found):
        print(f"{task_id}: skill from {expected}")
        return
    print(f"{task_id}: expected the skill from {expected}, found: {', '.join(found) or 'none'}")
    sys.exit(1)


if __name__ == "__main__":
    main()
