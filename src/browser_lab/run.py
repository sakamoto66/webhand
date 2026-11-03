"""Harness smoke test: the fixed script, no model. Agent runs go through the browser-lab CLI."""

import argparse
import importlib.util
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .agent import GOAL_REPORTED, Budget, run_agent
from .browser import Browser
from .metrics import Recorder, git_state, summarize
from .policies.scripted import ScriptedPolicy

ROOT = Path.cwd()


def load_task(name: str):
    path = ROOT / "tasks" / f"{name}.py"
    if not path.is_file():
        raise SystemExit(f"Unknown task: {name}")
    spec = importlib.util.spec_from_file_location(f"tasks.{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_once(task_name: str, task, repeat: int, folder: Path, args) -> bool:
    recorder = Recorder(folder / f"{task_name}-scripted-{repeat}.jsonl")
    browser = None
    result, verdict = {"status": "error", "reason": None}, {"success": False, "evidence": None}
    try:
        policy = ScriptedPolicy(task.SCRIPT)
        browser = Browser(task.start_url(ROOT), headless=not args.headed)
        recorder.event(
            "run_start",
            task=task_name,
            goal=task.GOAL,
            policy="scripted",
            repeat=repeat,
            config=policy.config(),
            chrome=browser.version,
            git=git_state(),
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        plan = {"goal": task.GOAL, "steps": [], "values": []}
        outcome = run_agent(browser, policy, plan, recorder, Budget(args.max_actions, args.max_decisions))
        outcome.pop("page")
        result = {**outcome, "status": "done" if outcome["outcome"] == GOAL_REPORTED else "blocked"}
        verdict = task.verify(browser)
    except Exception as error:  # A failed run is data: keep it and move to the next one.
        result = {**result, "reason": f"{type(error).__name__}: {error}"}
    finally:
        if browser:
            browser.close()
    summary = summarize(recorder.calls)
    recorder.event("run_end", **result, verified=verdict["success"], evidence=verdict["evidence"], **summary)
    recorder.close()
    reason = result.get("reason") or result.get("detail")
    print(f"{task_name}#{repeat}: {result['status']} verified={verdict['success']} reason={reason}")
    return verdict["success"]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--max-actions", type=int, default=Budget.max_actions)
    parser.add_argument("--max-decisions", type=int, default=Budget.max_decisions)
    args = parser.parse_args(argv)

    task = load_task(args.task)
    folder = ROOT / "runs" / time.strftime("%Y%m%dT%H%M%S")
    passed = [run_once(args.task, task, repeat, folder, args) for repeat in range(1, args.repeat + 1)]
    print(f"{sum(passed)}/{len(passed)} verified. Logs: {folder}")
    return 0 if all(passed) else 1


if __name__ == "__main__":
    sys.exit(main())
