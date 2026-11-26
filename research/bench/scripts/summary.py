"""Mean score over judged tasks: python summary.py

Every prepared task counts. A prepared task without a result is listed as unscored, never dropped.
"""

import json
from collections import Counter
from statistics import mean

import denials
from common import RESULTS, ROUND, WORK, picks_files, project_slug


def seeds() -> dict[str, str]:
    """Task ID -> the seed it was picked with, from picks-<seed>.txt."""
    found = {}
    for _, picks in sorted(picks_files().items()):
        for task_id in picks.read_text().split():
            found[task_id] = picks.stem.removeprefix("picks-")
    return found


def condition(task_id: str, seed: str | None) -> str:
    """The seed, which skill the session read, and the webhand commit of the CLI."""
    meta = json.loads((WORK / task_id / "meta.json").read_text())
    if meta.get("skill_repo"):
        skill = f"skill from repository {meta['skill_repo_commit'][:7]}"
    else:
        skill = f"installed plugin {meta.get('webhand_plugin') or 'unknown'}"
    where = f"round {ROUND}, " if ROUND else ""
    cli = meta.get("cli_repo_commit") or meta.get("webhand_commit") or "unrecorded"
    return f"{where}seed {seed or 'unknown'}: {skill}, CLI {cli[:7]}"


def ended(task_id: str) -> str | None:
    path = WORK / task_id / "ended_by"
    return path.read_text().split()[0] if path.exists() else None


def refused(task_id: str) -> dict:
    """What the auto mode classifier, and permission rules or a person, refused in this task's sessions (counts only)."""
    project = project_slug((WORK / task_id).resolve())
    total = {"denied": 0, "no_verdict": 0, "rule_denied": 0, "reasons": Counter()}
    for transcript in denials.work_transcripts(project):
        found = denials.count(transcript)
        for key in ("denied", "no_verdict", "rule_denied"):
            total[key] += found[key]
        total["reasons"].update(found["reasons"])
    return total


def main() -> None:
    prepared = sorted(p.name for p in WORK.iterdir() if p.is_dir()) if WORK.exists() else []
    groups: dict[str, tuple[list[dict], list[str]]] = {}
    picked = seeds()
    for task_id in prepared:
        rows, unscored = groups.setdefault(condition(task_id, picked.get(task_id)), ([], []))
        result = RESULTS / task_id / "result.json"
        if result.exists():
            rows.append(json.loads(result.read_text()))
        else:
            unscored.append(task_id)
    for name, (rows, unscored) in groups.items():
        print(f"== {name}")
        for row in rows:
            r = refused(row["task_id"])
            print(
                f"{row['task_id']}\t{row['score']:.3f}\t{row['verdict']}\t{row['findings']}"
                f"\tclassifier denied {r['denied']}, no verdict {r['no_verdict']}, rule/person denied {r['rule_denied']}"
            )
        if rows:
            print(
                f"judged {len(rows)}: mean score {mean(r['score'] for r in rows):.3f}, "
                f"all items met {sum(bool(r['verdict']) for r in rows)}/{len(rows)}"
            )
        if unscored:
            print(f"unscored {len(unscored)}: {' '.join(unscored)}")
        hit = [(r["task_id"], refused(r["task_id"])) for r in rows]
        hit = [(t, f) for t, f in hit if f["denied"]]
        if hit:  # Kept and scored; the classifier, not webhand, refused a command in these sessions.
            print("classifier denied a command (kept and scored): " + ", ".join(f"{t} {dict(f['reasons'])}" for t, f in hit))
        stalled = [r["task_id"] for r in rows if ended(r["task_id"]) == "stalled"]
        if stalled:  # Kept and scored, but the session stopped for a reason outside the agent.
            print(f"stalled (outside the agent; kept and scored) {len(stalled)}: {' '.join(stalled)}")

if __name__ == "__main__":
    main()
