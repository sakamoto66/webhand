"""Checks that a finished session ran on the model in its meta.json: python check_model.py bu2-001

Reads the Claude Code transcripts of the task's folder and counts the model of each assistant message. Exits 1
when any message came from another model, or when meta.json names no model (prepared before 2026-11-09).
"""

import json
import sys
from collections import Counter
from pathlib import Path

from common import WORK, project_slug

task_id = sys.argv[1]
work = WORK / task_id
expected = json.loads((work / "meta.json").read_text()).get("model")
folder = Path.home() / ".claude" / "projects" / project_slug(work.resolve())
counts = Counter()
for transcript in folder.glob("*.jsonl"):
    for line in transcript.read_text().split("\n"):
        if not line:
            continue
        event = json.loads(line)
        model = (event.get("message") or {}).get("model") if event.get("type") == "assistant" else None
        if model and model != "<synthetic>":
            counts[model] += 1
(work / "models").write_text(json.dumps(counts) + "\n")
if not expected or set(counts) - {expected}:
    print(f"{task_id}: expected {expected}, ran on {dict(counts)}")
    sys.exit(1)
