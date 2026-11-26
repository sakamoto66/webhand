"""Checks that a finished session ran webhand in the flow in its meta.json: python check_flow.py bu2-001

Reads the run_start events in the task's WEBHAND_HOME logs (a run without `flow` ran v1). Writes the counts to
work/<id>/flows and exits 1 when any run used another flow. A session that started no run passes.
"""

import json
import sys
from collections import Counter

from common import WORK

task_id = sys.argv[1]
work = WORK / task_id
expected = json.loads((work / "meta.json").read_text()).get("flow", "v1")
counts = Counter()
for log in (work / "home" / "runs").glob("*/*.jsonl"):
    for line in log.read_text().split("\n"):
        if not line:
            continue
        event = json.loads(line)
        if event.get("type") == "run_start":
            counts[event.get("flow") or "v1"] += 1
(work / "flows").write_text(json.dumps(counts) + "\n")
if set(counts) - {expected}:
    print(f"{task_id}: expected flow {expected}, ran {dict(counts)}")
    sys.exit(1)
print(f"{task_id}: flow {expected} ({sum(counts.values())} runs)")
