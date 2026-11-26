"""Shared paths and helpers for scoring webhand runs with the BU Bench V2.1 findings judge.

The code is this folder (research/bench in the webhand repository). Data lives outside the repository.

Data layout (override the root with WEBHAND_BENCH):
  benchmark/       browser-use/benchmark at the pinned release tag
  work/<id>/       one evaluation session: prompt, launch script, outputs/, home/ (WEBHAND_HOME)
  results/<id>/    trace.json, judge artifacts (they quote the rubric: never show them to Claude), result.json

Never publish decrypted tasks, rubrics, traces or judge artifacts.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

CODE = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.get("WEBHAND_BENCH") or Path.home() / "webhand-bench").resolve()
BENCH = ROOT / "benchmark"
# BENCH_ROUND runs the same tasks again under another condition, in their own folders (work-<round>/,
# results-<round>/), so a task can be compared with itself. Unset: the first round (work/, results/).
ROUND = os.environ.get("BENCH_ROUND", "")
if ROUND and not ROUND.replace("-", "").isalnum():
    raise SystemExit(f"BENCH_ROUND must be letters, digits, and '-': {ROUND!r}")
WORK = ROOT / (f"work-{ROUND}" if ROUND else "work")
RESULTS = ROOT / (f"results-{ROUND}" if ROUND else "results")
BENCHMARK = "BU_Bench_V2"

# The benchmark's modules (judge, evaluation) must win over same-named files anywhere else.
sys.path[:] = [str(BENCH)] + [p for p in sys.path if Path(p or ".").resolve() != BENCH]


def load_task(task_id: str) -> dict:
    from evaluation import load_tasks

    for task in load_tasks(BENCHMARK):
        if task["task_id"] == task_id:
            return task
    raise SystemExit(f"Unknown task id: {task_id}")


def task_ids() -> list[str]:
    from evaluation import load_tasks

    return [task["task_id"] for task in load_tasks(BENCHMARK)]


def provenance() -> dict:
    """What a score depends on: the benchmark revision and the webhand CLI and plugin versions."""

    def run(*args: str) -> str | None:
        try:
            return subprocess.run(args, capture_output=True, text=True, check=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return None

    enc = BENCH / f"{BENCHMARK}.enc"
    return {
        "benchmark_commit": run("git", "-C", str(BENCH), "rev-parse", "HEAD"),
        "benchmark_tag": run("git", "-C", str(BENCH), "describe", "--tags", "--always"),
        "dataset_sha256": hashlib.sha256(enc.read_bytes()).hexdigest() if enc.exists() else None,
        "webhand_cli": run("webhand", "--version"),
        "webhand_commit": webhand_commit(run),
        "webhand_plugin": plugin_version(),
    }


def webhand_commit(run) -> str | None:
    """The commit and dirty state of the checkout that the linked `webhand` command runs from."""
    import shutil

    found = shutil.which("webhand")
    if not found:
        return None
    root = Path(found).resolve().parent.parent  # <repo>/dist/bin.js
    commit = run("git", "-C", str(root), "rev-parse", "HEAD")
    dirty = run("git", "-C", str(root), "status", "--porcelain", "--untracked-files=no")
    return f"{commit}{'-dirty' if dirty else ''}" if commit else None


def plugin_version() -> str | None:
    path = Path.home() / ".claude" / "plugins" / "installed_plugins.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    entries = (data.get("plugins") or data).get("webhand@webhand")
    if isinstance(entries, list) and entries:
        return entries[0].get("version")
    if isinstance(entries, dict):
        return entries.get("version")
    return None


def picks_files() -> dict[str, Path]:
    """picks-<seed>.txt by name: the repository's, and any still only in the data root. The repository's wins."""
    return {p.name: p for folder in (ROOT, CODE / "picks") for p in folder.glob("picks-*.txt")}


def project_slug(path: Path) -> str:
    """Claude Code's folder name for a working directory under ~/.claude/projects."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2))
