"""Write every task's instruction for a person to translate and check by hand: python export_tasks.py

Writes analysis/tasks-raw.jsonl: one line per task with task_id and confirmed_task (the instruction an agent
is given), and nothing else: no rubric, no answer. Run it in a session that does not improve webhand, and
never commit or publish the file (decrypted task text).
"""

import json

from common import BENCHMARK, ROOT


def main() -> None:
    from evaluation import load_tasks

    out = ROOT / "analysis" / "tasks-raw.jsonl"
    out.parent.mkdir(exist_ok=True)
    tasks = load_tasks(BENCHMARK)
    with out.open("w") as f:
        for task in sorted(tasks, key=lambda t: t["task_id"]):
            f.write(json.dumps({"task_id": task["task_id"], "confirmed_task": task["confirmed_task"]}, ensure_ascii=False) + "\n")
    print(f"Wrote {len(tasks)} tasks to {out}")


if __name__ == "__main__":
    main()
