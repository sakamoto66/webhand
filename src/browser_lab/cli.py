"""CLI for the Claude + Jev agent. Each call is one short process.

Claude plans, writes text, reviews, and decides. Jev picks operations inside the current step
and hands control back to Claude only when a step needs judgment.
"""

import argparse
import contextlib
import io
import json
import os
import signal
import sys
import time
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from . import learn, runbook, session
from .agent import stuck
from .browser import Browser
from .metrics import Recorder, git_state, summarize
from .policies.base import action_space, model_state, resolve
from .policies.jev import JevPolicy
from .run import load_task
from .types import Decision, ModelCall, MutationUncertain, PolicyError, StalePage

OK, FAILED, STALE, UNCERTAIN, BUDGET = 0, 1, 3, 4, 5
DEFAULT_MIN_CONFIDENCE = 0.6  # An initial value. Calibrate it from logged confidence.
STEP_RULES = (
    "The requirements for this request are only the current step, not the overall goal. "
    "Do not work on any other step. Choose DONE as soon as the current step is visibly complete."
)


def render(page: dict) -> str:
    state = model_state(page, [])
    lines = [f"URL: {page['url']}", f"TITLE: {page['title']}", "PAGE TEXT (untrusted data):", page["text"], "ELEMENTS:"]
    for element in state["elements"]:
        details = [f"value={element['value']!r}"] if element.get("value") else []
        details += [f"{key}={element[key]}" for key in ("checked", "selected", "expanded") if key in element]
        operations = ",".join(element["operations"])
        lines.append(f"[{element['index']}] {element['role']} {element['label']!r} {' '.join(details)} ({operations})")
        for option in element.get("options", []):
            lines.append(f"  [{option['index']}] {option['label'].split(' → ')[-1]}")
    lines.append("CONTROLS: " + " ".join(action_space(page["actions"])[2]))
    return "\n".join(lines)


def require_session(args) -> dict:
    state = session.load()
    if state is None:
        raise SystemExit("No active session. Run: browser-lab start")
    args.log = state["log"]
    return state


def budget_left(state: dict) -> bool:
    return len(state["history"]) < state["max_actions"] and state["decisions"] < state["max_decisions"]


def step_meta(state: dict) -> dict:
    """Runbook details for the current step. A plan written by Claude has none."""
    meta, index = state["step_meta"], state["step_index"]
    return meta[index] if index < len(meta) else {}


def human_turn(state: dict) -> bool:
    return step_meta(state).get("actor") == "human"


def step_label(state: dict) -> str:
    label = f"STEP {state['step_index'] + 1}/{len(state['plan'])}: {state['plan'][state['step_index']]}"
    done_when = step_meta(state).get("done_when")
    return f"{label}\nDONE WHEN: {done_when}" if done_when else label


def step_goal(state: dict) -> str:
    meta = step_meta(state)
    notes = [f"Hint: {hint}" for hint in meta.get("hints", [])]
    if meta.get("done_when"):
        notes.append(f"This step is complete when: {meta['done_when']}")
    return "\n".join(
        [
            f"Current step: {state['plan'][state['step_index']]}",
            f"Overall goal, for context only: {state['goal']}",
            *notes,
            STEP_RULES,
        ]
    )


def execute(state: dict, browser: Browser, decision: Decision, recorder: Recorder, text, decided_by: str) -> None:
    """Runs once. Logged before the next observation so a navigation cannot erase it."""
    page, action = state["page"], decision.action
    browser.act(action, page, text=text)
    step = {
        "step": len(state["history"]) + 1,
        "plan_step": state["step_index"] + 1,
        "decided_by": decided_by,
        "confidence": decision.confidence,
        "operation": decision.operation,
        "kind": action["kind"],
        "action": action["label"],
        "text": text,
        "url": page["url"],
        "page_changed": None,
    }
    state["history"].append(step)
    recorder.event("step", **step)
    session.save(state)
    state["page"] = browser.observe()
    step["page_changed"] = state["page"]["marker"] != page["marker"]
    recorder.event("step_result", step=step["step"], page_changed=step["page_changed"])
    session.save(state)


def command_start(args) -> int:
    if session.load():
        raise SystemExit("A session is active. Run: browser-lab finish --status abandoned")
    task = load_task(args.task) if args.task else None
    book = None
    if args.runbook:
        try:
            book = runbook.load(args.runbook, runbook.parse_values(args.param))
        except runbook.RunbookError as error:
            raise SystemExit(str(error)) from None
        if book["status"] != "approved" and not args.allow_draft:
            raise SystemExit(f"Runbook {args.runbook} is a draft. Trial it with --allow-draft, then get it approved")
        if any(step["actor"] == "human" for step in book["steps"]) and not args.headed:
            raise SystemExit("This runbook has human steps. Add --headed so the person can see the window")
    if task is None and book is None and not (args.url and args.goal):
        raise SystemExit("Give --task, --runbook, or both --url and --goal")
    if not os.environ.get("TYPESAFE_API_KEY"):
        raise SystemExit("TYPESAFE_API_KEY is not set. Run through: uv run --env-file .env browser-lab ...")
    goal = task.GOAL if task else book["goal"] if book else args.goal
    url = task.start_url(Path.cwd()) if task else book["start_url"] if book else args.url
    chrome = session.start_chrome(headed=args.headed)
    default_log = Path("runs") / time.strftime("%Y%m%dT%H%M%S") / f"{args.task or 'adhoc'}.jsonl"
    state = {
        **chrome,
        "task": args.task,
        "goal": goal,
        "plan": [],
        "step_meta": [],
        "runbook": book,
        "step_index": 0,
        "history": [],
        "decisions": 0,
        "pending": None,
        "min_confidence": args.min_confidence,
        "max_actions": args.max_actions,
        "max_decisions": args.max_decisions,
        "started": time.time(),
        "log": os.environ.get("BROWSER_LAB_LOG") or str(default_log),
    }
    args.log = state["log"]
    recorder = Recorder(Path(state["log"]))
    browser = None
    try:
        browser = Browser(url, port=chrome["port"])
        state["page"] = browser.observe()
        recorder.event(
            "run_start",
            task=args.task,
            goal=goal,
            chrome=browser.version,
            git=git_state(),
            min_confidence=args.min_confidence,
            runbook={k: book[k] for k in ("name", "status", "digest")} if book else None,
            started_at=datetime.now(timezone.utc).isoformat(),
        )
    except Exception:
        session.stop_chrome(chrome)
        raise
    finally:
        if browser:
            browser.close()
        recorder.close()
    session.save(state)
    if book:
        steps = "\n".join(f"{i}. [{s['actor']}] {s['instruction']}" for i, s in enumerate(book["steps"], 1))
        print(f"GOAL: {goal}\n{render(state['page'])}\nRUNBOOK {book['name']} ({book['status']}):\n{steps}")
        print('NEXT: browser-lab plan --runbook, or browser-lab plan "step" ... if the runbook does not fit')
        return OK
    print(f"GOAL: {goal}\n{render(state['page'])}\nNEXT: browser-lab plan \"step\" \"step\" ...")
    return OK


def command_plan(args) -> int:
    state = require_session(args)
    if bool(args.steps) == bool(args.runbook):
        print("REJECTED: give either steps or --runbook")
        return FAILED
    if args.runbook and not state["runbook"]:
        print("REJECTED: this run was not started with --runbook")
        return FAILED
    meta = state["runbook"]["steps"] if args.runbook else []
    steps = [step["instruction"] for step in meta] or args.steps
    state.update(plan=steps, step_meta=meta, step_index=0, pending=None)
    session.save(state)
    with contextlib.closing(Recorder(Path(state["log"]))) as recorder:
        recorder.event("plan", steps=steps, source="runbook" if args.runbook else "claude")
    print(f"{step_label(state)}\nNEXT: browser-lab advance")
    return OK


def command_observe(args) -> int:
    state = require_session(args)
    browser = Browser(port=state["port"])
    try:
        state["page"] = browser.observe()
    finally:
        browser.close()
    session.save(state)
    print(render(state["page"]))
    return OK


def command_act(args) -> int:
    """Claude overrides Jev for one operation."""
    state = require_session(args)
    if human_turn(state):
        print("REJECTED: a person is working on this step. Wait for them, then observe and advance --next")
        return FAILED
    if not budget_left(state):
        print("BUDGET EXHAUSTED. Run: browser-lab finish --status budget")
        return BUDGET
    try:
        decision = resolve(state["page"], args.operation, args.target)
    except PolicyError as error:
        print(f"REJECTED: {error}")
        return FAILED
    if decision.action is None:
        print("REJECTED: use advance --next to confirm a step, or finish to end the run")
        return FAILED
    if decision.action["kind"] == "fill" and args.text is None:
        print("REJECTED: TYPE_TEXT needs --text")
        return FAILED
    state["decisions"] += 1
    state["pending"] = None
    session.save(state)
    browser, recorder = Browser(port=state["port"]), Recorder(Path(state["log"]))
    try:
        execute(state, browser, decision, recorder, args.text, "claude")
        print(render(state["page"]))
        return OK
    except StalePage as error:
        state["page"] = browser.observe()
        session.save(state)
        print(f"STALE, nothing executed: {error}\n{render(state['page'])}")
        return STALE
    except MutationUncertain as error:
        print(f"UNCERTAIN, do not repeat this action: {error}. Run: browser-lab finish --status error")
        return UNCERTAIN
    finally:
        browser.close()
        recorder.close()


def command_advance(args) -> int:
    """Jev works through the current step until Claude's judgment is needed."""
    state = require_session(args)
    if not state["plan"]:
        print('REJECTED: run browser-lab plan "step" ... first')
        return FAILED
    if args.next:
        if human_turn(state):
            with contextlib.closing(Recorder(Path(state["log"]))) as recorder:
                recorder.event("human_step", status="done", plan_step=state["step_index"] + 1)
            browser = Browser(port=state["port"])  # The person changed the page; refresh what is printed next.
            try:
                state["page"] = browser.observe()
            finally:
                browser.close()
        state["pending"] = None
        state["step_index"] += 1
        session.save(state)
    if state["step_index"] >= len(state["plan"]):
        print(f"ALL STEPS CONFIRMED. Review the page, then run finish.\n{render(state['page'])}")
        return OK
    if human_turn(state):
        # Jev is not called and nothing is typed. The person works in the visible window.
        with contextlib.closing(Recorder(Path(state["log"]))) as recorder:
            recorder.event("escalation", reason="HUMAN_STEP", plan_step=state["step_index"] + 1)
            recorder.event("human_step", status="requested", plan_step=state["step_index"] + 1)
        print(f"ESCALATION HUMAN_STEP\n{step_label(state)}\nAsk the person to do this in the Chrome window.")
        return OK
    pending = state["pending"]
    if pending:
        needs_text = pending["action"]["kind"] == "fill"
        if needs_text and args.text is None:
            print("REJECTED: this step needs --text")
            return FAILED
        if not needs_text and not args.accept:
            print("REJECTED: pass --accept, or override with act")
            return FAILED

    policy = JevPolicy()
    browser, recorder = Browser(port=state["port"]), Recorder(Path(state["log"]))

    def flush():
        for call in policy.calls:
            recorder.call(call)
        policy.calls.clear()

    def escalate(reason: str, detail: str) -> int:
        recorder.event("escalation", reason=reason, plan_step=state["step_index"] + 1)
        session.save(state)
        print(f"ESCALATION {reason}\n{step_label(state)}\n{detail}")
        return OK

    try:
        while True:
            try:
                if pending:
                    state["pending"], decision = None, Decision(**pending)
                    pending = None
                    execute(state, browser, decision, recorder, args.text, "jev")
                if stuck(state["history"]):
                    return escalate("STUCK", render(state["page"]))
                if not budget_left(state):
                    print("BUDGET EXHAUSTED. Run: browser-lab finish --status budget")
                    return BUDGET
                if not browser.fresh(state["page"]):
                    state["page"] = browser.observe()
                state["decisions"] += 1
                decision = policy.choose(state["page"], step_goal(state), state["history"])
                flush()
                session.save(state)
                if decision.action is None:
                    if not browser.fresh(state["page"]):
                        continue
                    reason = "STEP_DONE" if decision.operation == "DONE" else "JEV_BLOCKED"
                    return escalate(reason, render(state["page"]))
                if decision.action["kind"] == "fill":
                    state["pending"] = asdict(decision)
                    field = {k: decision.action.get(k) for k in ("label", "role", "value")}
                    return escalate("NEEDS_TEXT", json.dumps(field, ensure_ascii=False))
                if decision.confidence is not None and decision.confidence < state["min_confidence"]:
                    state["pending"] = asdict(decision)
                    proposal = f"{decision.operation} {decision.action['label']!r} ({decision.confidence:.2f})"
                    return escalate("LOW_CONFIDENCE", f"JEV PROPOSES: {proposal}\n{render(state['page'])}")
                execute(state, browser, decision, recorder, None, "jev")
            except StalePage:
                state["page"] = browser.observe()
                session.save(state)
    except PolicyError as error:
        flush()
        recorder.event("escalation", reason="JEV_FAILED", plan_step=state["step_index"] + 1)
        print(f"ESCALATION JEV_FAILED, nothing executed: {error}\n{render(state['page'])}")
        return FAILED
    except MutationUncertain as error:
        print(f"UNCERTAIN, do not repeat: {error}. Run: browser-lab finish --status error")
        return UNCERTAIN
    finally:
        flush()
        browser.close()
        recorder.close()


def run_totals(log: str) -> dict:
    calls, escalations, decided_by = [], Counter(), Counter()
    handoffs = handoff_chars = 0
    for line in Path(log).read_text(encoding="utf-8").splitlines():
        event = json.loads(line)
        kind = event.pop("type")
        if kind == "call":
            calls.append(ModelCall(**event))
        elif kind == "escalation":
            escalations[event["reason"]] += 1
        elif kind == "step":
            decided_by[event["decided_by"]] += 1
        elif kind == "handoff":
            handoffs += 1
            handoff_chars += event["chars"]
    return {
        **summarize(calls),
        "escalations": dict(escalations),
        "decided_by": dict(decided_by),
        "handoffs": handoffs,
        "handoff_chars": handoff_chars,
    }


def command_learn(args) -> int:
    """A person demonstrates a procedure. The only long-running command, so run it in the background."""
    try:
        runbook.path(args.name)
    except runbook.RunbookError as error:
        raise SystemExit(str(error)) from None
    stem = args.name.replace("/", "-")
    default_log = Path("runs") / time.strftime("%Y%m%dT%H%M%S") / f"learn-{stem}.jsonl"
    args.log = os.environ.get("BROWSER_LAB_LOG") or str(default_log)
    chrome = session.start_chrome(headed=not args.headless)
    deadline = time.monotonic() + args.max_minutes * 60
    browser, recorder = None, Recorder(Path(args.log))
    stopped = []
    signal.signal(signal.SIGTERM, lambda *_: stopped.append(True))  # Stopping the job still saves and closes.
    try:
        browser = Browser(port=chrome["port"])
        recorder.event(
            "learn_start",
            name=args.name,
            url=args.url,
            chrome=browser.version,
            git=git_state(),
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        counts = learn.record(browser, args.url, recorder, lambda: stopped or time.monotonic() >= deadline)
        recorder.event("learn_end", counts=dict(counts))
    finally:
        if browser:
            browser.close()
        session.stop_chrome(chrome)
        recorder.close()
    print(f"RECORDED {dict(counts)} log={args.log}")
    if counts["unsupported"]:
        print("WARNING: the record has operations the agent cannot reproduce. See its unsupported events")
    return OK


def command_finish(args) -> int:
    """Verifies the page independently. The status is what the agent claims, nothing more."""
    state = session.load()
    if state is None:
        raise SystemExit("No active session. Run: browser-lab start")
    verdict = {"success": None, "evidence": "no verifier"}
    try:
        if state["task"]:
            browser = Browser(port=state["port"])
            try:
                verdict = load_task(state["task"]).verify(browser)
            finally:
                browser.close()
    except Exception as error:
        verdict = {"success": False, "evidence": f"{type(error).__name__}: {error}"}
    finally:
        session.stop_chrome(state)
        session.clear()
    totals = run_totals(state["log"])
    with contextlib.closing(Recorder(Path(state["log"]))) as recorder:
        recorder.event(
            "run_end",
            status=args.status,
            reason=args.reason,
            plan=state["plan"],
            actions=len(state["history"]),
            decisions=state["decisions"],
            elapsed_ms=round((time.time() - state["started"]) * 1000),
            verified=verdict["success"],
            evidence=verdict["evidence"],
            **totals,
        )
    print(f"FINISHED status={args.status} verified={verdict['success']} log={state['log']}")
    return OK


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="browser-lab", description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    start = commands.add_parser("start", help="Open a disposable Chrome and print the first observation")
    start.add_argument("--task")
    start.add_argument("--url")
    start.add_argument("--goal")
    start.add_argument("--headed", action="store_true")
    start.add_argument("--min-confidence", type=float, default=DEFAULT_MIN_CONFIDENCE)
    start.add_argument("--runbook", help="Use a procedure from runbooks/, such as hotel/filter")
    start.add_argument("--param", action="append", default=[], metavar="KEY=VALUE", help="A runbook parameter")
    start.add_argument("--allow-draft", action="store_true", help="Trial a runbook no person has approved yet")
    start.add_argument("--max-actions", type=int, default=30)
    start.add_argument("--max-decisions", type=int, default=60)
    start.set_defaults(run=command_start)

    plan = commands.add_parser("plan", help="Claude: set or replace the ordered steps")
    plan.add_argument("steps", nargs="*")
    plan.add_argument("--runbook", action="store_true", help="Adopt the steps of the run's runbook")
    plan.set_defaults(run=command_plan)

    advance = commands.add_parser("advance", help="Jev: work on the current step until it escalates")
    advance.add_argument("--text", help="Claude's value for a NEEDS_TEXT escalation")
    advance.add_argument("--accept", action="store_true", help="Claude accepts a LOW_CONFIDENCE proposal")
    advance.add_argument("--next", action="store_true", help="Claude confirms this step and moves on")
    advance.set_defaults(run=command_advance)

    act = commands.add_parser("act", help="Claude: override Jev with one operation")
    act.add_argument("operation")
    act.add_argument("target", nargs="?")
    act.add_argument("--text")
    act.set_defaults(run=command_act)

    commands.add_parser("observe", help="Print the current page").set_defaults(run=command_observe)

    learn_command = commands.add_parser("learn", help="Record a person demonstrating a procedure")
    learn_command.add_argument("--name", required=True, help="Runbook name, such as hotel/filter")
    learn_command.add_argument("--url", required=True)
    learn_command.add_argument("--max-minutes", type=float, default=30)
    learn_command.add_argument("--headless", action="store_true", help=argparse.SUPPRESS)
    learn_command.set_defaults(run=command_learn)

    finish = commands.add_parser("finish", help="Verify, log, and close Chrome")
    finish.add_argument("--status", required=True, choices=["done", "blocked", "budget", "error", "abandoned"])
    finish.add_argument("--reason")
    finish.set_defaults(run=command_finish)
    return root


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    args.log = None
    # What Claude must read is a real cost of this design, so every handoff is sized and logged.
    output = io.StringIO()
    try:
        with contextlib.redirect_stdout(output):
            return args.run(args)
    finally:
        text = output.getvalue()
        sys.stdout.write(text)
        if args.log:
            with contextlib.closing(Recorder(Path(args.log))) as recorder:
                recorder.event("handoff", command=args.command, chars=len(text))


if __name__ == "__main__":
    sys.exit(main())
