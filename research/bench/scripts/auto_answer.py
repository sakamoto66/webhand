#!/usr/bin/env python3
"""PreToolUse hook for AskUserQuestion: answers with the fixed sentence of the README's rules, as a person would.

Claude Code passes the tool call as JSON on stdin; the answer goes back through updatedInput.answers (the question text
-> the answer text), so no option is chosen and nobody types. The fixed sentences:
  - a question about a sign-in, password, verification code, or CAPTCHA (NEEDS_HUMAN): "対応できません。手元の情報だけで進めてください。"
  - any other: "お答えできません。手元の情報だけで進めてください。"
Every answer is appended to auto_answers.jsonl in WEBHAND_HOME (or the session's cwd), so a run shows it was automatic.
"""

import json
import os
import re
import sys
import time
from pathlib import Path

DEFAULT = "お答えできません。手元の情報だけで進めてください。"
HUMAN = "対応できません。手元の情報だけで進めてください。"
HUMAN_WORDS = re.compile(r"captcha|ログイン|サインイン|パスワード|認証コード|確認コード|sign.?in|log.?in|password|verification code", re.I)


def main() -> None:
    call = json.load(sys.stdin)
    if call.get("tool_name") != "AskUserQuestion":
        return
    tool_input = call.get("tool_input") or {}
    questions = tool_input.get("questions") or []
    answers = {}
    for q in questions:
        text = f"{q.get('question', '')} " + " ".join(f"{o.get('label', '')} {o.get('description', '')}" for o in q.get("options", []))
        answers[q["question"]] = HUMAN if HUMAN_WORDS.search(text) else DEFAULT
    home = Path(os.environ.get("WEBHAND_HOME") or call.get("cwd") or ".")
    try:
        with open(home / "auto_answers.jsonl", "a") as f:
            f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "session": call.get("session_id"), "answers": list(answers.values())}, ensure_ascii=False) + "\n")
    except OSError:
        pass  # Answering matters more than the note.
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": {**tool_input, "answers": answers}}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
