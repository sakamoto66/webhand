"""NOT_VISIBLE counts per task and round, from webhand's own run logs only (no judge output, no page text).

python nv_counts.py A B   -> task / events in A / events in B, and how many had frames, canvases or objects unseen.
"""

import json
import sys

from common import ROOT


def counts(round_name: str) -> dict[str, tuple[int, int]]:
    found = {}
    for task in sorted((ROOT / f"work-{round_name}").glob("*/")):
        if (task / "invalid").exists():
            continue
        events = unseen = 0
        for log in (task / "home" / "runs").glob("*/*.jsonl"):
            for line in log.read_text().splitlines():
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("type") == "not_visible":
                    events += 1
                    u = e.get("unseen") or {}
                    unseen += any(u.get(k) for k in ("frames", "canvases", "objects"))
        found[task.name] = (events, unseen)
    return found


def main() -> None:
    a, b = sys.argv[1:3]
    ca, cb = counts(a), counts(b)
    print(f"NOT_VISIBLE events (with unseen frames/canvases/objects), by task: {a} / {b}")
    for t in sorted(set(ca) | set(cb)):
        x, y = ca.get(t, (0, 0)), cb.get(t, (0, 0))
        if x[0] or y[0]:
            print(f"{t}\t{x[0]} ({x[1]})\t{y[0]} ({y[1]})")
    print(f"total\t{sum(v[0] for v in ca.values())} ({sum(v[1] for v in ca.values())})\t{sum(v[0] for v in cb.values())} ({sum(v[1] for v in cb.values())})")


main()
