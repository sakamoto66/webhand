"""Collect and score every launched task that has no result yet: python score_pending.py

A task whose collect or judge step fails is reported and left unscored; summary.py lists it as unscored.
"""

import subprocess
import sys
from pathlib import Path

from common import RESULTS, WORK

HERE = Path(__file__).parent


def running_dirs() -> set[Path]:
    """Working directories of live claude processes: their sessions are not finished."""
    found = set()
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if (proc / "comm").read_text().strip() == "claude":
                found.add((proc / "cwd").resolve())
        except OSError:
            continue
    return found


def main() -> None:
    running = running_dirs()
    for work in sorted(p for p in WORK.iterdir() if (p / "started_at").exists()):
        if (RESULTS / work.name / "result.json").exists():
            continue
        if (work / "invalid").exists():
            print(f"{work.name}: marked invalid ({(work / 'invalid').read_text().strip()}); not scored")
            continue
        if work.resolve() in running:
            print(f"{work.name}: its Claude Code session is still running; skipped")
            continue
        for script in ("collect.py", "score.py"):
            done = subprocess.run([sys.executable, str(HERE / script), work.name])
            if done.returncode:
                print(f"{work.name}: {script} failed; left unscored")
                break


if __name__ == "__main__":
    main()
