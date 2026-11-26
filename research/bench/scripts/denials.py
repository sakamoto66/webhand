"""Counts what Claude Code's auto mode classifier did in a session: python denials.py TRANSCRIPT.jsonl

The classifier approves or refuses commands in a session that runs in auto mode. It is outside webhand's conditions, so a
tally shows it beside the result instead of letting it pass unseen:
  denied      the classifier refused a command ("denied by the Claude Code auto mode classifier. Reason: [..]")
  no_verdict  it gave no verdict (a transient error, or a hook changed the call after review); the call did not run
  rule_denied a permission rule or a person refused a command ("Permission to use .. has been denied"): the session's
              deny rules (such as Bash(*tasks/*)) show up here. Round 25 failed this way and nothing showed it.
Only counts and reasons are read. Nothing of the task or the page is kept.
"""

import json
import sys
from collections import Counter
from pathlib import Path


def count(transcript: Path) -> dict:
    """{'denied': n, 'reasons': {reason: n}, 'no_verdict': n, 'rule_denied': n} for one session transcript (missing: zeros)."""
    out = {"denied": 0, "reasons": Counter(), "no_verdict": 0, "rule_denied": 0}
    if not transcript.exists():
        return out
    for line in transcript.read_text().split("\n"):
        if "auto mode classifier" not in line and "has been denied" not in line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        content = (entry.get("message") or {}).get("content")
        for block in content if isinstance(content, list) else []:
            if block.get("type") != "tool_result":
                continue
            text = block["content"] if isinstance(block["content"], str) else json.dumps(block["content"], ensure_ascii=False)
            if "auto mode classifier" not in text:
                if text.startswith("Permission to use") and "has been denied" in text:
                    out["rule_denied"] += 1
                continue
            marker = "denied by the Claude Code auto mode classifier. Reason: ["
            if marker in text:
                out["denied"] += 1
                out["reasons"][text.split(marker, 1)[1].split("]", 1)[0]] += 1
            else:
                out["no_verdict"] += 1
    out["reasons"] = dict(out["reasons"])
    return out


def work_transcripts(project_dir: str) -> list[Path]:
    """Transcripts of the sessions started in one working directory (a BU Bench task's work folder)."""
    return sorted((Path.home() / ".claude" / "projects" / project_dir).glob("*.jsonl"))


if __name__ == "__main__":
    print(json.dumps(count(Path(sys.argv[1]))))
