"""Checks that a finished session ran the CLI of the checkout in its meta.json: python check_cli.py bu2-001

Reads cli_used.log in the task's WEBHAND_HOME, where the `webhand` dispatcher notes the checkout of every call. Exits 1 when a
call ran another checkout, or when the session called webhand but the log is empty. A task prepared without BENCH_CLI_REPO passes.
"""

import json
import sys
from collections import Counter

from common import WORK

task_id = sys.argv[1]
work = WORK / task_id
expected = json.loads((work / "meta.json").read_text()).get("cli_repo")
if not expected:
    print(f"{task_id}: no CLI repository chosen (the linked checkout)")
    sys.exit(0)
log = work / "home" / "cli_used.log"
counts = Counter(log.read_text().split()) if log.exists() else Counter()
started = any((work / "home" / "runs").glob("*/*.jsonl"))
(work / "clis").write_text(json.dumps(counts) + "\n")
if set(counts) - {expected} or (started and not counts):
    print(f"{task_id}: expected CLI {expected}, ran {dict(counts)}")
    sys.exit(1)
print(f"{task_id}: CLI {expected} ({sum(counts.values())} calls)")
