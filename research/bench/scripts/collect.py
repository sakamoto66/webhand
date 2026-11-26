"""Turn one evaluation session into the judge's trace: python collect.py bu2-001

Sources, all on this machine:
  - the Claude Code transcript of the session started in work/<id>/ (text, tool calls and their results)
  - webhand's run logs in work/<id>/home/runs/ and the screenshots beside them
  - deliverables in work/<id>/outputs/, read with the benchmark's own collector

The trace has the BrowserCode runner's shape. Each webhand screenshot is labelled with the tool call
(a webhand CLI command) that was running when the file was written.
"""

import argparse
import base64
import json
from datetime import datetime
from pathlib import Path

from common import RESULTS, WORK, project_slug, write_json

CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"
SLACK_S = 2.0  # File times and transcript times come from the same clock; allow for write latency.
NOTE = (
    "Screenshots were captured by the webhand CLI, not chosen by the agent, right after each browser "
    "action it executed. Each is labelled with the tool call (a webhand command) that ran that action; "
    "one call can run several actions, so several screenshots can share a step. Browsing outside webhand "
    "has no screenshots."
)


def parse_time(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def transcript(work: Path) -> Path:
    folder = CLAUDE_PROJECTS / project_slug(work)
    sessions = sorted(folder.glob("*.jsonl"))
    if len(sessions) != 1:
        found = ", ".join(p.name for p in sessions) or "none"
        raise SystemExit(f"Expected exactly one Claude Code session in {folder}, found: {found}")
    return sessions[0]


def result_text(content) -> str:
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if block.get("type") == "text":
            parts.append(block.get("text") or "")
        elif block.get("type") == "image":
            parts.append("[image viewed by the agent; not attached]")
    return "\n".join(parts)


def read_transcript(path: Path) -> tuple[list[str], str, list[dict], list[str]]:
    """Agent steps in order, the final response, timed tool calls, and notes."""
    steps: list[str] = []
    calls: dict[str, dict] = {}
    final = ""
    prompts = 0
    notes: list[str] = []
    for line in path.read_text().split("\n"):  # Not splitlines: JSON strings can hold U+2028.
        if not line:
            continue
        entry = json.loads(line)
        if entry.get("type") not in ("user", "assistant") or entry.get("isSidechain"):
            continue
        message = entry.get("message") or {}
        content = message.get("content")
        when = parse_time(entry["timestamp"]) if entry.get("timestamp") else None
        if entry["type"] == "assistant":
            for block in content or []:
                kind = block.get("type")
                if kind == "text" and (block.get("text") or "").strip():
                    steps.append(f"text: {block['text']}")
                    final = block["text"]
                elif kind == "thinking" and (block.get("thinking") or "").strip():
                    steps.append(f"reasoning: {block['thinking']}")
                elif kind == "tool_use":
                    steps.append("")
                    calls[block["id"]] = {
                        "index": len(steps) - 1,
                        "tool": block.get("name"),
                        "input": block.get("input"),
                        "start": when,
                        "end": None,
                    }
            continue
        if entry.get("isMeta"):
            continue
        if isinstance(content, str):
            prompts += 1
            if prompts > 1:  # The first is the task prompt; later ones are a person typing.
                steps.append(f"user: {content}")
            continue
        for block in content or []:
            if block.get("type") == "tool_result" and block.get("tool_use_id") in calls:
                call = calls[block["tool_use_id"]]
                call["end"] = when
                error = bool(block.get("is_error"))
                text = result_text(block.get("content"))
                call["output"], call["error"] = (None, text) if error else (text, None)
                call["status"] = "error" if error else "completed"
            elif block.get("type") == "text" and not entry.get("toolUseResult"):
                prompts += 1
                if prompts > 1:
                    steps.append(f"user: {block.get('text') or ''}")
    for call in calls.values():
        steps[call["index"]] = json.dumps(
            {
                "tool": call["tool"],
                "input": call["input"],
                "output": call.get("output"),
                "error": call.get("error"),
                "status": call.get("status", "no result"),
            },
            ensure_ascii=False,
        )
    if (path.parent / path.stem / "subagents").exists():
        notes.append("The session used subagents; their steps are not in this trace.")
    return steps, final, sorted(calls.values(), key=lambda c: c["index"]), notes


def screenshots(home: Path, calls: list[dict]) -> tuple[list[str], list[int], list[str]]:
    shots, errors = [], []
    for log in sorted((home / "runs").glob("*/*.jsonl")):
        for line in log.read_text().split("\n"):
            if not line:
                continue
            event = json.loads(line)
            if event.get("type") == "screenshot":
                file = log.parent / event["file"]
                if file.exists():
                    shots.append((file.stat().st_mtime, file))
                else:
                    errors.append(f"Missing screenshot file: {event['file']}")
            elif event.get("type") == "screenshot_failed":
                errors.append(f"webhand could not capture after step {event.get('step')}: {event.get('error')}")
    images, steps = [], []
    for mtime, file in sorted(shots):
        running = [c for c in calls if c["start"] and c["start"] - SLACK_S <= mtime <= (c["end"] or mtime) + SLACK_S]
        earlier = [c for c in calls if c["start"] and c["start"] <= mtime]
        call = (running or earlier or [None])[-1]
        if call is None:
            errors.append(f"No tool call for screenshot {file.name}")
            continue
        images.append(base64.b64encode(file.read_bytes()).decode())
        steps.append(call["index"] + 1)  # The judge numbers steps from 1.
    return images, steps, errors


def main() -> None:
    from bcode_runner import collect_outputs

    parser = argparse.ArgumentParser()
    parser.add_argument("task_id")
    args = parser.parse_args()
    work = WORK / args.task_id
    if not (work / "started_at").exists():
        raise SystemExit(f"{work} has not been launched")
    agent_steps, final, calls, notes = read_transcript(transcript(work))
    images, image_steps, evidence_errors = screenshots(work / "home", calls)
    files_text, output_images, file_errors = collect_outputs(work / "outputs")
    evidence_errors += file_errors
    ended = (work / "ended_by").read_text().split()[0] if (work / "ended_by").exists() else None
    if ended == "time-limit":  # Same note as the BrowserCode runner.
        agent_steps.append("Executor notes: Task timed out after 3600s; grading preserved partial work")
    if evidence_errors:
        agent_steps.append("Evidence collection errors: " + "\n".join(evidence_errors))
    trace = {
        "final_result": final,
        "agent_steps": agent_steps,
        "screenshots_b64": images,
        "screenshot_steps": image_steps,
        "screenshot_timing": "after",
        "output_files_text": files_text,
        "output_images": output_images,
        "evidence_errors": evidence_errors,
        "evidence_notes": [NOTE, *notes],
    }
    write_json(RESULTS / args.task_id / "trace.json", trace)
    webhand_calls = sum(1 for c in calls if "webhand" in json.dumps(c["input"]))
    print(
        f"{args.task_id}: {len(agent_steps)} steps, {len(calls)} tool calls ({webhand_calls} webhand), "
        f"{len(images)} screenshots, {len(output_images)} image files, "
        f"{len(files_text)} chars of files, {len(evidence_errors)} evidence errors"
    )


if __name__ == "__main__":
    main()
