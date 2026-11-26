"""Score one collected trace with the benchmark's findings judge: python score.py bu2-001

Needs OPENAI_API_KEY (paid). Prints numbers only. The judge's input and response quote the rubric; they
stay in results/<id>/judge/ and must never be shown to a Claude session that runs tasks.
A task is judged once; --again keeps the earlier result beside the new one.
"""

import argparse
import asyncio
import json
import shutil
from collections import Counter
from datetime import UTC, datetime

from common import BENCHMARK, RESULTS, WORK, load_task, provenance, write_json


def main() -> None:
    from evaluation import create_judge, judge_config, judge_trace

    parser = argparse.ArgumentParser()
    parser.add_argument("task_id")
    parser.add_argument("--judge-model", default=None)
    parser.add_argument("--judge-reasoning", default="xhigh")
    parser.add_argument("--again", action="store_true", help="judge again; the earlier result is kept")
    args = parser.parse_args()
    out = RESULTS / args.task_id
    result_file = out / "result.json"
    if result_file.exists():
        if not args.again:
            raise SystemExit(f"{result_file} exists. Pass --again to judge again (costs another call).")
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
        result_file.rename(out / f"result-{stamp}.json")
        if (out / "judge").exists():
            shutil.move(out / "judge", out / f"judge-{stamp}")
    task = load_task(args.task_id)
    trace = json.loads((out / "trace.json").read_text())
    llm = create_judge(BENCHMARK, model=args.judge_model, reasoning_effort=args.judge_reasoning)
    scored = asyncio.run(judge_trace(task, trace, llm, BENCHMARK, artifact_dir=out / "judge"))
    judgement = scored.pop("judgement")
    statuses = Counter(f["status"] for f in judgement["findings"])
    meta_file = WORK / args.task_id / "meta.json"
    result = {
        "task_id": args.task_id,
        "score": scored["score"],
        "verdict": scored["verdict"],
        "earned_weight": scored["earned_weight"],
        "rh_zeroed": scored["rh_zeroed"],
        "canary_leak": scored["canary_leak"],
        "missing_items": scored["missing_items"],
        "evidence_missing_items": scored.get("evidence_missing_items", []),
        "evidence_clipped_sections": scored.get("evidence_clipped_sections", []),
        "findings": dict(statuses),
        "flags": {k: judgement[k] for k in ("infra_error", "pii_present", "reward_hacking_suspected")},
        "screenshots": {
            "input": scored.get("screenshot_evidence", {}).get("input_count"),
            "sent": len(scored.get("screenshot_evidence", {}).get("source_indices", [])),
        },
        "judge": judge_config(BENCHMARK, llm),
        "judged_at": datetime.now(UTC).isoformat(),
        "prepared": json.loads(meta_file.read_text()) if meta_file.exists() else None,
        "judged_with": provenance(),
    }
    write_json(result_file, result)
    flags = ",".join(k for k, v in result["flags"].items() if v) or "none"
    print(
        f"{args.task_id}: score {result['score']:.3f} (earned {result['earned_weight']}/100), "
        f"verdict {result['verdict']}, findings {dict(statuses)}, flags {flags}, "
        f"canary_leak {result['canary_leak']}"
    )


if __name__ == "__main__":
    main()
