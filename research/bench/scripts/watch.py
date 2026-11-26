"""Close one evaluation session when it is done: python watch.py bu2-001

Runs beside launch.sh. It ends the session's claude process (SIGTERM) when either
  - the agent's last turn ended (stop_reason end_turn) and nothing was written for IDLE_S seconds, or
  - the session stalled: Claude Code waited STALL_S seconds for the model's reply (the last entry is a prompt
    or a tool result, so no tool is running) with nothing written, or
  - TIME_LIMIT_S passed since the session started.
A pending question or permission prompt is not idle: the turn has not ended, so the watcher waits. A running
tool (the last entry is its call) is never a stall, however long it takes.
Why the session ended goes to work/<id>/ended_by; collect.py adds a timeout note to the trace.
"""

import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from common import WORK, project_slug

IDLE_S = int(os.environ.get("BENCH_IDLE_S", "180"))
# From 2026-11-15: once `webhand finish` has been reported (a run_end in the task's logs), a turn that ended is the end of
# the work and no question is waiting, so the session closes after DONE_S instead of IDLE_S. Before this, every session
# waited the full IDLE_S: about 3 of the 4.4 minutes a session took (median of rounds sa and sb).
DONE_S = int(os.environ.get("BENCH_DONE_S", "30"))
TIME_LIMIT_S = int(os.environ.get("BENCH_TIME_LIMIT_S", "3600"))
STALL_S = int(os.environ.get("BENCH_STALL_S", "600"))
POLL_S = 5


def claude_pids(work: Path) -> list[int]:
    pids = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if (proc / "comm").read_text().strip() == "claude" and (proc / "cwd").resolve() == work:
                pids.append(int(proc.name))
        except OSError:
            continue
    return pids


def state(transcript: Path) -> str:
    """'ended' when the agent's turn ended, 'asking' while an AskUserQuestion waits, 'waiting' while Claude Code
    waits for the model's reply (the last entry is a prompt or a tool result), else 'working' (a tool runs)."""
    last = None
    asked: set[str] = set()
    for line in transcript.read_text().split("\n"):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") not in ("user", "assistant") or entry.get("isMeta"):
            continue
        last = entry
        for block in (entry.get("message") or {}).get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use" and block.get("name") == "AskUserQuestion":
                asked.add(block.get("id"))
            elif block.get("type") == "tool_result":
                asked.discard(block.get("tool_use_id"))
    if asked:
        return "asking"
    if last and last["type"] == "assistant" and (last.get("message") or {}).get("stop_reason") == "end_turn":
        return "ended"
    if last and last["type"] == "user":
        return "waiting"
    return "working"


def turn_ended(transcript: Path) -> bool:
    return state(transcript) == "ended"


def beep() -> None:
    subprocess.run([str(Path(__file__).with_name("beep.sh"))], check=False)


def started(work: Path) -> float:
    text = (work / "started_at").read_text().strip()
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


def finished(work: Path) -> bool:
    """webhand finish was reported: some run log of this session has run_end."""
    return any('"run_end"' in log.read_text() for log in (work / "home" / "runs").glob("*/*.jsonl"))


def main() -> None:
    work = (WORK / sys.argv[1]).resolve()
    folder = Path.home() / ".claude" / "projects" / project_slug(work)
    deadline = time.time() + 60
    while not (work / "started_at").exists() or not claude_pids(work):
        if time.time() > deadline:
            (work / "ended_by").write_text(f"not-started {datetime.now().astimezone().isoformat()}\n")
            return
        time.sleep(1)
    begin = started(work)
    seen = "working"
    while pids := claude_pids(work):
        now = time.time()
        reason = None
        sessions = sorted(folder.glob("*.jsonl"))
        current = state(sessions[0]) if len(sessions) == 1 else "working"
        if current != seen and current in ("asking", "ended"):
            beep()  # A question, or a turn that ended: the person may need to answer.
        seen = current
        if now - begin >= TIME_LIMIT_S:
            reason = "time-limit"
        elif current == "ended" and now - sessions[0].stat().st_mtime >= (DONE_S if finished(work) else IDLE_S):
            reason = "idle-after-turn"
        elif current == "waiting" and now - sessions[0].stat().st_mtime >= STALL_S:
            reason = "stalled"  # Outside the agent: Claude Code or the model API stopped answering.
        if reason:
            (work / "ended_by").write_text(f"{reason} {datetime.now().astimezone().isoformat()}\n")
            for pid in pids:
                os.kill(pid, signal.SIGTERM)
            time.sleep(10)
            for pid in claude_pids(work):
                os.kill(pid, signal.SIGKILL)
            return
        time.sleep(POLL_S)
    if not (work / "ended_by").exists():
        (work / "ended_by").write_text(f"person {datetime.now().astimezone().isoformat()}\n")


if __name__ == "__main__":
    main()
