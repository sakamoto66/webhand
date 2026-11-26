"""Compare two rounds of the same tasks: python compare.py ROUND [--base BASE] [--picks picks-20261107.txt]

Pairs results/<id> (or results-<BASE>/) with results-<ROUND>/<id>, task by task. Shows scores only, never
judge text, and adds counts from webhand's own run logs: runs, runs with a read layer, ATTEMPT_BUDGET stops,
the share of scroll actions, and session minutes. A task scored in one round only is listed, not dropped.
"""

import argparse
import json
from datetime import datetime
from pathlib import Path
from statistics import mean, stdev

from common import ROOT, picks_files


def folders(round_name: str) -> tuple[Path, Path]:
    suffix = f"-{round_name}" if round_name else ""
    return ROOT / f"work{suffix}", ROOT / f"results{suffix}"


def score(results: Path, task_id: str) -> float | None:
    path = results / task_id / "result.json"
    return json.loads(path.read_text())["score"] if path.exists() else None


def log_counts(work: Path, task_id: str) -> dict:
    counts = {"runs": 0, "read_runs": 0, "budget": 0, "actions": 0, "scrolls": 0, "minutes": None}
    for log in sorted((work / task_id / "home" / "runs").glob("*/*.jsonl")):
        counts["runs"] += 1
        read = False
        operations = {}
        for line in log.read_text().split("\n"):
            if not line:
                continue
            event = json.loads(line)
            kind = event["type"]
            if kind == "plan" and (event.get("view") or {}).get("read"):
                read = True
            elif kind == "escalation" and event.get("reason") == "ATTEMPT_BUDGET":
                counts["budget"] += 1
            elif kind == "step":
                operations[event["step"]] = event.get("operation")
        counts["read_runs"] += read
        counts["actions"] += len(operations)
        counts["scrolls"] += sum(1 for op in operations.values() if str(op).startswith("SCROLL"))
    started, ended = work / task_id / "started_at", work / task_id / "ended_by"
    if started.exists() and ended.exists():
        begin = datetime.fromisoformat(started.read_text().strip().replace("Z", "+00:00"))
        end = datetime.fromisoformat(ended.read_text().split()[1])
        counts["minutes"] = round((end - begin).total_seconds() / 60, 1)
    return counts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("round")
    parser.add_argument("--base", default="")
    parser.add_argument("--picks", default="picks-20261107.txt")
    args = parser.parse_args()
    ids = picks_files().get(args.picks, ROOT / args.picks).read_text().split()
    (base_work, base_results), (new_work, new_results) = folders(args.base), folders(args.round)
    header = ["task", "base", args.round, "diff", "runs", "read runs", "budget stops", "scroll share", "minutes"]
    print("\t".join(header))
    diffs, totals = [], {"base": {"actions": 0, "scrolls": 0, "budget": 0}, "new": {"actions": 0, "scrolls": 0, "budget": 0}}
    for task_id in ids:
        a, b = score(base_results, task_id), score(new_results, task_id)
        ca, cb = log_counts(base_work, task_id), log_counts(new_work, task_id)
        for name, counts in (("base", ca), ("new", cb)):
            for key in totals[name]:
                totals[name][key] += counts[key]
        diff = None if a is None or b is None else b - a
        if diff is not None:
            diffs.append(diff)
        share = lambda c: f"{c['scrolls'] / c['actions']:.0%}" if c["actions"] else "-"  # noqa: E731
        cell = lambda v: "unscored" if v is None else f"{v:.2f}"  # noqa: E731
        print("\t".join([task_id, cell(a), cell(b), "-" if diff is None else f"{diff:+.2f}",
                         f"{ca['runs']}->{cb['runs']}", f"{ca['read_runs']}->{cb['read_runs']}",
                         f"{ca['budget']}->{cb['budget']}", f"{share(ca)}->{share(cb)}",
                         f"{ca['minutes']}->{cb['minutes']}"]))
    if diffs:
        spread = stdev(diffs) / len(diffs) ** 0.5 if len(diffs) > 1 else 0.0
        print(f"paired {len(diffs)}: mean diff {mean(diffs):+.3f} (standard error {spread:.3f}), "
              f"better {sum(d > 0 for d in diffs)}, worse {sum(d < 0 for d in diffs)}, same {sum(d == 0 for d in diffs)}")
    for name, t in totals.items():
        share = f"{t['scrolls'] / t['actions']:.0%}" if t["actions"] else "-"
        print(f"{name}: {t['actions']} actions, scroll share {share}, ATTEMPT_BUDGET stops {t['budget']}")


if __name__ == "__main__":
    main()
