"""CLI for the Claude + Jev agent. Each call is one short process.

Claude plans the goal, steps, and values, reviews the outcome, and replans. Jev chooses every
operation toward the goal and hands control back only when it cannot continue on its own.
"""

import argparse
import contextlib
import io
import json
import os
import shutil
import signal
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from . import agent, learn, runbook, session
from .agent import Budget, execute, run_agent
from .browser import Browser
from .metrics import Recorder, git_state, summarize
from .policies.base import action_space, model_state, plan_text, resolve
from .policies.jev import JevPolicy
from .run import load_task
from .types import ModelCall, MutationUncertain, PolicyError, StalePage

OK, FAILED, STALE, UNCERTAIN, BUDGET = 0, 1, 3, 4, 5
DEFAULT_ATTEMPTS = 3
PERSON = "[person]"
RECENT = 8  # Actions shown to Claude when an attempt stops.


# --- Output Claude reads -------------------------------------------------------------------


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
    hidden = state["page"]["offscreen"]
    lines.append(f"OFFSCREEN: {hidden['above_px']}px above, {hidden['below_px']}px below")
    return "\n".join(lines)


def headline(page: dict) -> str:
    return f"URL: {page['url']}\nTITLE: {page['title']}"


def describe_plan(plan: dict) -> str:
    lines = [f"GOAL: {plan['goal']}", "PLAN:", *[f"  {line}" for line in plan_text(plan) or ["(goal only)"]]]
    if plan["values"]:
        lines.append("VALUES: " + ", ".join(value["label"] for value in plan["values"]))
    return "\n".join(lines)


def recent_actions(state: dict) -> str:
    rows = [h for h in state["history"] if h.get("attempt") == state["plan"]["attempt"]][-RECENT:]
    lines = [
        f"  {h['step']}. {h['operation'] if h['kind'] != 'human' else 'HUMAN'} {h['action']!r}"
        + (f" text={h['text']!r}" if h.get("text") else "")
        + ("" if h["page_changed"] else " (page unchanged)")
        for h in rows
    ]
    return "ACTIONS THIS ATTEMPT:\n" + ("\n".join(lines) if lines else "  (none)")


# --- Plan and session state ----------------------------------------------------------------


def parse_values(pairs: list[str]) -> list[dict]:
    values = []
    for pair in pairs:
        label, separator, value = pair.partition("=")
        if not separator or not label.strip():
            raise SystemExit(f"Expected --value LABEL=VALUE, got {pair!r}")
        values.append({"label": label.strip(), "value": value})
    return values


def merge_values(current: list[dict], new: list[dict]) -> list[dict]:
    merged = {value["label"]: value for value in current}
    merged.update({value["label"]: value for value in new})
    return list(merged.values())


def parse_steps(texts: list[str]) -> list[dict]:
    """A step written as "[person] Sign in" is one a person does in the window."""
    steps = []
    for text in texts:
        human = text.startswith(PERSON)
        steps.append({"actor": "human" if human else "jev", "instruction": text.removeprefix(PERSON).strip()})
    return steps


def require_session(args) -> dict:
    state = session.load()
    if state is None:
        raise SystemExit("No active session. Run: browser-lab start")
    args.log = state["log"]
    return state


def open_page(state: dict, url: str | None = None) -> None:
    browser = Browser(url, port=state["port"])
    try:
        state["page"] = browser.observe()
    finally:
        browser.close()
    session.save(state)


def attempt_label(state: dict) -> str:
    return f"attempt {state['plan']['attempt']}/{state['max_attempts']}"


def log_event(state: dict, kind: str, **fields) -> None:
    with contextlib.closing(Recorder(Path(state["log"]))) as recorder:
        recorder.event(kind, **fields)


# --- Commands ------------------------------------------------------------------------------


def command_catalog(args) -> int:
    """Everything learned, for Claude to plan from."""
    services = runbook.catalog()
    if not services:
        print("NOTHING LEARNED. Plan from the request, or teach a service with /browser-lab-learn")
    for entry in services:
        info = entry["info"]
        print(f"SERVICE {entry['service']}")
        if info:
            print(f"  {info['description']}\n  base_url: {info['base_url']}")
            login = info["login"]
            print(
                f"  login: {'required' if login['required'] else 'not required'}"
                + (f" ({login['url']})" if login["url"] else "")
            )
            for page in info["pages"]:
                print(f"  page: {page['url']} — {page['purpose']}")
            for fact in info["facts"]:
                print(f"  fact: {fact}")
        else:
            print("  (no service.toml)")
        for procedure in entry["procedures"]:
            print(f"  PROCEDURE {procedure['name']} [{procedure['status']}]: {procedure['goal']}")
            print(f"    start_url: {procedure['start_url']}")
            for key, description in procedure["params"].items():
                print(f"    param {key}: {description}")
            if procedure["human_steps"]:
                print(f"    human steps: {procedure['human_steps']} (needs --headed)")
    chrome, note = session.choose_chrome(args.chrome)
    profiles = session.list_profiles(chrome)
    print(f"CHROME: {chrome}" + (f" ({note})" if note else ""))
    print("SAVED PROFILES: " + (", ".join(profiles) if profiles else "(none)"))
    return OK


def command_start(args) -> int:
    if session.load():
        raise SystemExit("A session is active. Run: browser-lab finish --status abandoned")
    task = load_task(args.task) if args.task else None
    if task and args.goal:
        raise SystemExit("A task supplies its own goal. Drop --goal")
    book = None
    try:
        if args.runbook:
            book = runbook.load(args.runbook, runbook.parse_values(args.param))
            if book["status"] != "approved" and not args.allow_draft:
                raise SystemExit(
                    f"Runbook {args.runbook} is a draft. Trial it with --allow-draft, then get it approved"
                )
        service_name = args.service or (book["service"] if book else None)
        service = runbook.load_service(service_name) if service_name else None
        profile = session.parse_session(args.session)
        chrome, note = session.choose_chrome(args.chrome)
    except (runbook.RunbookError, session.SessionError) as error:
        raise SystemExit(str(error)) from None
    goal = task.GOAL if task else args.goal or (book["goal"] if book else None)
    url = task.start_url(Path.cwd()) if task else args.url or (book["start_url"] if book else None)
    if not (goal and url):
        raise SystemExit("Give --task, --runbook, or both --goal and --url")
    if args.step:
        steps = parse_steps(args.step)
    elif book:
        steps = book["steps"]
    else:
        steps = []
    values = parse_values(args.value)
    if book:  # Runbook parameters are Claude's values too, unless Claude labelled them itself.
        params = [{"label": key, "value": value} for key, value in runbook.parse_values(args.param).items()]
        values = merge_values(params, values)
    if any(step["actor"] == "human" for step in steps) and not args.headed:
        raise SystemExit("This plan has [person] steps. Add --headed so the person can see the window")
    if not os.environ.get("TYPESAFE_API_KEY"):
        raise SystemExit("TYPESAFE_API_KEY is not set. Run through: uv run --env-file .env browser-lab ...")
    plan = {
        "goal": goal,
        "steps": steps,
        "values": values,
        "notes": [],
        "attempt": 1,
        "service": {"description": service["description"], "facts": service["facts"]} if service else None,
    }
    try:
        chrome_state = session.start_chrome(headed=args.headed, profile=profile, chrome=chrome)
    except session.SessionError as error:
        raise SystemExit(str(error)) from None
    default_log = Path("runs") / time.strftime("%Y%m%dT%H%M%S") / f"{args.task or 'adhoc'}.jsonl"
    state = {
        **chrome_state,
        "task": args.task,
        "start_url": session.browser_url(url, chrome),
        "plan": plan,
        "runbook": {k: book[k] for k in ("name", "status", "digest")} if book else None,
        "history": [],
        "decisions": 0,
        "attempt_decisions": 0,
        "outcome": None,
        "outcomes": [],
        "max_attempts": args.max_attempts,
        "max_actions": args.max_actions,
        "max_decisions": args.max_decisions,
        "started": time.time(),
        "log": os.environ.get("BROWSER_LAB_LOG") or str(default_log),
    }
    args.log = state["log"]
    recorder = Recorder(Path(state["log"]))
    browser = None
    try:
        browser = Browser(state["start_url"], port=chrome_state["port"])
        state["page"] = browser.observe()
        recorder.event(
            "run_start",
            task=args.task,
            goal=goal,
            chrome=browser.version,
            chrome_host=chrome,
            session="profile" if profile else "new",
            git=git_state(),
            runbook=state["runbook"],
            service=service_name,
            max_attempts=args.max_attempts,
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        recorder.event(
            "plan",
            attempt=1,
            steps=plan_text(plan),
            values=[v["label"] for v in values],
            source="runbook" if book and not args.step else "claude",
        )
    except Exception:
        session.stop_chrome(chrome_state)
        raise
    finally:
        if browser:
            browser.close()
        recorder.close()
    session.save(state)
    if note:
        print(f"NOTE: {note}")
    print(f"{describe_plan(plan)}\nSESSION: {args.session} ({chrome} Chrome)\n{headline(state['page'])}")
    print("NEXT: browser-lab run")
    return OK


def report(state: dict, result: dict) -> int:
    """What Claude needs for this outcome, and nothing more."""
    outcome = result["outcome"]
    print(f"OUTCOME {outcome} ({attempt_label(state)}): {result['detail']}")
    if outcome == agent.UNCERTAIN:
        print("Do not repeat or replan. Run: browser-lab finish --status error")
        return UNCERTAIN
    if outcome == agent.NEEDS_HUMAN:
        print(f"{headline(state['page'])}\nAsk the person to do this in the Chrome window, then: run --human-done")
        return OK
    if outcome == agent.NEEDS_VALUE:
        print(f"FIELD: {json.dumps(result['field'], ensure_ascii=False)}")
        print("Give the value with: run --value 'LABEL=VALUE'. Never invent personal data; ask the person")
        return OK
    print(f"{recent_actions(state)}\n{render(state['page'])}")
    if outcome == agent.GOAL_REPORTED:
        print("Check the page against the goal. If it is met: finish --status done. Otherwise: replan")
    elif outcome == agent.JEV_FAILED:
        print("Nothing was executed. Run again, replan, or act")
    else:
        print("NEXT: replan --reason '...' [--restart], act, or finish")
    return OK


def command_run(args) -> int:
    """Jev works toward the goal until it needs Claude or a person."""
    state = require_session(args)
    outcome = state["outcome"]
    if outcome == agent.UNCERTAIN:
        print("REJECTED: the last action may have happened. Run: browser-lab finish --status error")
        return UNCERTAIN
    if outcome == agent.NEEDS_HUMAN and not args.human_done:
        print("REJECTED: a person is acting. When they are done: run --human-done")
        return FAILED
    if outcome == agent.NEEDS_VALUE and not args.value:
        print("REJECTED: this field needs run --value 'LABEL=VALUE'")
        return FAILED
    if outcome in {agent.GOAL_REPORTED, agent.BLOCKED, agent.STUCK, agent.ATTEMPT_BUDGET}:
        print(f"REJECTED: the attempt ended with {outcome}. Run replan, act, or finish")
        return FAILED
    if args.value:
        state["plan"]["values"] = merge_values(state["plan"]["values"], parse_values(args.value))
        log_event(
            state, "values", attempt=state["plan"]["attempt"], labels=[v["label"] for v in parse_values(args.value)]
        )
    if args.human_done:
        if outcome != agent.NEEDS_HUMAN:
            print("REJECTED: no person was asked to act")
            return FAILED
        log_event(state, "human_step", status="done", attempt=state["plan"]["attempt"])
        open_page(state)  # The person changed the page.
        state["history"].append(
            {
                "step": len(state["history"]) + 1,
                "attempt": state["plan"]["attempt"],
                "kind": "human",
                "operation": "HUMAN",
                "action": "A person did the step that needed them",
                "text": None,
                "url": state["page"]["url"],
                "page_changed": True,
            }
        )
    state["outcome"] = None
    session.save(state)

    policy = JevPolicy()
    browser, recorder = Browser(port=state["port"]), Recorder(Path(state["log"]))

    def changed(page):
        state["page"] = page
        session.save(state)

    def decided(count):
        state["attempt_decisions"] = count
        state["decisions"] += 1

    try:
        result = run_agent(
            browser,
            policy,
            state["plan"],
            recorder,
            Budget(state["max_actions"], state["max_decisions"]),
            history=state["history"],
            page=state["page"],
            decisions=state["attempt_decisions"],
            on_change=changed,
            on_decision=decided,
        )
        state["page"], state["outcome"] = result["page"], result["outcome"]
        recorder.event(
            "escalation", reason=result["outcome"], attempt=state["plan"]["attempt"], detail=result["detail"]
        )
        if result["outcome"] == agent.NEEDS_HUMAN:
            recorder.event("human_step", status="requested", attempt=state["plan"]["attempt"])
        session.save(state)
    finally:
        browser.close()
        recorder.close()
    return report(state, result)


def command_replan(args) -> int:
    """Claude revises the plan after an attempt fell short, and starts the next attempt."""
    state = require_session(args)
    plan = state["plan"]
    if state["outcome"] == agent.UNCERTAIN:
        print("REJECTED: the last action may have happened, so the run cannot continue. Run: finish --status error")
        return UNCERTAIN
    if plan["attempt"] >= state["max_attempts"]:
        print(f"ATTEMPTS EXHAUSTED ({state['max_attempts']}). Run: browser-lab finish --status blocked")
        return BUDGET
    if args.step:
        steps = parse_steps(args.step)
        if any(step["actor"] == "human" for step in steps) and not state["headed"]:
            print("REJECTED: [person] steps need a visible window, and this run is headless")
            return FAILED
        plan["steps"] = steps
    plan["values"] = merge_values(plan["values"], parse_values(args.value))
    ended = state["outcome"] or "CLAUDE_STOPPED"
    state["outcomes"].append({"attempt": plan["attempt"], "outcome": ended, "reason": args.reason})
    plan["notes"].append(f"Attempt {plan['attempt']} ended with {ended}. Claude: {args.reason}")
    plan["attempt"] += 1
    state.update(outcome=None, attempt_decisions=0)
    session.save(state)
    log_event(state, "attempt_end", attempt=plan["attempt"] - 1, outcome=ended, reason=args.reason)
    log_event(
        state,
        "plan",
        attempt=plan["attempt"],
        steps=plan_text(plan),
        values=[v["label"] for v in plan["values"]],
        restart=args.restart,
        source="claude",
    )
    if args.restart:
        open_page(state, state["start_url"])  # Navigation only; no earlier mutation is repeated.
    print(f"{describe_plan(plan)}\nATTEMPT {plan['attempt']}/{state['max_attempts']}\n{headline(state['page'])}")
    print("NEXT: browser-lab run")
    return OK


def command_observe(args) -> int:
    state = require_session(args)
    open_page(state)
    print(render(state["page"]))
    return OK


def command_act(args) -> int:
    """Claude overrides Jev for one operation."""
    state = require_session(args)
    if state["outcome"] == agent.NEEDS_HUMAN:
        print("REJECTED: a person is acting. When they are done: run --human-done")
        return FAILED
    if state["outcome"] == agent.UNCERTAIN:
        print("REJECTED: the last action may have happened. Run: browser-lab finish --status error")
        return UNCERTAIN
    if len(agent.actions_in(state["history"], state["plan"]["attempt"])) >= state["max_actions"]:
        print("BUDGET EXHAUSTED for this attempt. Run replan or finish --status budget")
        return BUDGET
    try:
        decision = resolve(state["page"], args.operation, args.target)
    except PolicyError as error:
        print(f"REJECTED: {error}")
        return FAILED
    if decision.action is None:
        print("REJECTED: act runs one operation. Use run, replan, or finish")
        return FAILED
    if decision.action["kind"] == "fill" and args.text is None:
        print("REJECTED: TYPE_TEXT needs --text")
        return FAILED
    decision.text = args.text if decision.action["kind"] == "fill" else None
    state["decisions"] += 1
    session.save(state)
    browser, recorder = Browser(port=state["port"]), Recorder(Path(state["log"]))

    def changed(page):
        state["page"] = page
        session.save(state)

    try:
        execute(
            browser,
            state["page"],
            decision,
            state["history"],
            recorder,
            decided_by="claude",
            attempt=state["plan"]["attempt"],
            on_change=changed,
        )
        if state["outcome"] != agent.ATTEMPT_BUDGET:
            state["outcome"] = None  # Claude stepped in, so Jev may continue this attempt with run.
            session.save(state)
        print(render(state["page"]))
        return OK
    except StalePage as error:
        state["page"] = browser.observe()
        session.save(state)
        print(f"STALE, nothing executed: {error}\n{render(state['page'])}")
        return STALE
    except MutationUncertain as error:
        state["outcome"] = agent.UNCERTAIN
        session.save(state)
        print(f"UNCERTAIN, do not repeat this action: {error}. Run: browser-lab finish --status error")
        return UNCERTAIN
    finally:
        browser.close()
        recorder.close()


def run_totals(log: str) -> dict:
    calls, escalations, decided_by = [], Counter(), Counter()
    handoffs = handoff_chars = not_visible = 0
    for line in Path(log).read_text(encoding="utf-8").splitlines():
        event = json.loads(line)
        kind = event.pop("type")
        if kind == "call":
            calls.append(ModelCall(**event))
        elif kind == "escalation":
            escalations[event["reason"]] += 1
        elif kind == "step":
            decided_by[event["decided_by"]] += 1
        elif kind == "not_visible":
            not_visible += 1
        elif kind == "handoff":
            handoffs += 1
            handoff_chars += event["chars"]
    return {
        **summarize(calls),
        "escalations": dict(escalations),
        "decided_by": dict(decided_by),
        "handoffs": handoffs,
        "handoff_chars": handoff_chars,
        "not_visible": not_visible,
    }


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
    plan = state["plan"]
    outcomes = [*state["outcomes"], {"attempt": plan["attempt"], "outcome": state["outcome"], "reason": args.reason}]
    totals = run_totals(state["log"])
    log_event(
        state,
        "run_end",
        status=args.status,
        reason=args.reason,
        goal=plan["goal"],
        plan=plan_text(plan),
        attempts=plan["attempt"],
        attempt_outcomes=outcomes,
        actions=len(state["history"]),
        decisions=state["decisions"],
        elapsed_ms=round((time.time() - state["started"]) * 1000),
        verified=verdict["success"],
        evidence=verdict["evidence"],
        **totals,
    )
    print(f"FINISHED status={args.status} verified={verdict['success']} attempts={plan['attempt']} log={state['log']}")
    return OK


def command_learn(args) -> int:
    """A person demonstrates a procedure. A long-running command, so run it in the background."""
    try:
        runbook.path(args.name)
        profile = session.parse_session(args.session)
        chrome, note = session.choose_chrome(args.chrome)
    except (runbook.RunbookError, session.SessionError) as error:
        raise SystemExit(str(error)) from None
    stem = args.name.replace("/", "-")
    default_log = Path("runs") / time.strftime("%Y%m%dT%H%M%S") / f"learn-{stem}.jsonl"
    args.log = os.environ.get("BROWSER_LAB_LOG") or str(default_log)
    chrome_state = session.start_chrome(headed=not args.headless, profile=profile, chrome=chrome)
    deadline = time.monotonic() + args.max_minutes * 60
    browser, recorder = None, Recorder(Path(args.log))
    stopped = []
    signal.signal(signal.SIGTERM, lambda *_: stopped.append(True))  # Stopping the job still saves and closes.
    try:
        browser = Browser(port=chrome_state["port"])
        recorder.event(
            "learn_start",
            name=args.name,
            url=args.url,
            chrome=browser.version,
            chrome_host=chrome,
            session="profile" if profile else "new",
            git=git_state(),
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        counts = learn.record(
            browser, session.browser_url(args.url, chrome), recorder, lambda: stopped or time.monotonic() >= deadline
        )
        recorder.event("learn_end", counts=dict(counts))
    finally:
        if browser:
            browser.close()
        session.stop_chrome(chrome_state)
        recorder.close()
    if note:
        print(f"NOTE: {note}")
    print(f"RECORDED {dict(counts)} log={args.log}")
    if counts["unsupported"]:
        print("WARNING: the record has operations the agent cannot reproduce. See its unsupported events")
    return OK


def command_profile(args) -> int:
    """Saved browser-lab profiles. A person signs in here directly; nothing is recorded or sent to Jev."""
    try:
        chrome, note = session.choose_chrome(args.chrome)
        if note:
            print(f"NOTE: {note}")
        if args.action == "list":
            profiles = session.list_profiles(chrome)
            print(f"SAVED PROFILES ({chrome}): " + (", ".join(profiles) if profiles else "(none)"))
            return OK
        if not args.name:
            raise SystemExit(f"profile {args.action} needs a NAME")
        folder = session.profile_dir(chrome, args.name)
        if args.action == "delete":
            if not folder.is_dir():
                print(f"No saved profile {args.name}")
                return FAILED
            shutil.rmtree(folder)
            print(f"DELETED profile {args.name}")
            return OK
        if not args.url:
            raise SystemExit("profile login needs --url")
        active = session.load()
        if active and active.get("saved_profile") == args.name:
            raise SystemExit(f"Profile {args.name} is in use by the active run. Finish it first")
        chrome_state = session.start_chrome(headed=True, profile=args.name, chrome=chrome)
    except session.SessionError as error:
        raise SystemExit(str(error)) from None
    deadline = time.monotonic() + args.max_minutes * 60
    stopped = []
    signal.signal(signal.SIGTERM, lambda *_: stopped.append(True))
    try:
        Browser(session.browser_url(args.url, chrome), port=chrome_state["port"]).close()
        # stdout is buffered for the handoff count, so the person sees this on stderr right away.
        print(f"OPENED profile {args.name}. Sign in in the Chrome window, then close the window", file=sys.stderr)
        session.wait_until_closed(chrome_state, lambda: stopped or time.monotonic() >= deadline)
    finally:
        session.stop_chrome(chrome_state)
    print(f"SAVED profile {args.name}. Use it with: start --session profile:{args.name}")
    return OK


# --- Parser --------------------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="browser-lab", description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    chrome_default = os.environ.get("BROWSER_LAB_CHROME", "auto")

    def chrome_option(command):
        command.add_argument(
            "--chrome",
            choices=sorted(session.CHROMES),
            default=chrome_default,
            help="auto uses the Windows Chrome on WSL when it is reachable",
        )

    catalog = commands.add_parser("catalog", help="List learned services, procedures, and saved profiles")
    chrome_option(catalog)
    catalog.set_defaults(run=command_catalog)

    start = commands.add_parser("start", help="Record Claude's plan and open the start page")
    start.add_argument("--goal")
    start.add_argument("--url")
    start.add_argument("--step", action="append", default=[], help='A plan step. "[person] ..." is done by a person')
    start.add_argument("--value", action="append", default=[], metavar="LABEL=VALUE", help="Text Jev may type")
    start.add_argument("--service", help="Learned service information to give Jev, such as hotel-site")
    start.add_argument("--runbook", help="A learned procedure, such as hotel/filter")
    start.add_argument("--param", action="append", default=[], metavar="KEY=VALUE", help="A runbook parameter")
    start.add_argument("--allow-draft", action="store_true", help="Trial a runbook no person has approved yet")
    start.add_argument("--task", help="A task in tasks/ with an independent verify()")
    start.add_argument("--session", default="new", help="new (temporary) or profile:NAME (saved sign-in)")
    chrome_option(start)
    start.add_argument("--headed", action="store_true")
    start.add_argument("--max-attempts", type=int, default=DEFAULT_ATTEMPTS)
    start.add_argument("--max-actions", type=int, default=Budget.max_actions, help="Per attempt")
    start.add_argument("--max-decisions", type=int, default=Budget.max_decisions, help="Per attempt")
    start.set_defaults(run=command_start)

    run = commands.add_parser("run", help="Jev: work toward the goal until Claude or a person is needed")
    run.add_argument("--value", action="append", default=[], metavar="LABEL=VALUE", help="Add or replace a value")
    run.add_argument("--human-done", action="store_true", help="The person finished what NEEDS_HUMAN asked")
    run.set_defaults(run=command_run)

    replan = commands.add_parser("replan", help="Claude: revise the plan and start the next attempt")
    replan.add_argument("--reason", required=True, help="Why the last attempt fell short; Jev sees it")
    replan.add_argument("--step", action="append", default=[], help="Replace the steps")
    replan.add_argument("--value", action="append", default=[], metavar="LABEL=VALUE")
    replan.add_argument("--restart", action="store_true", help="Open the start URL again before the next attempt")
    replan.set_defaults(run=command_replan)

    act = commands.add_parser("act", help="Claude: override Jev with one operation")
    act.add_argument("operation")
    act.add_argument("target", nargs="?")
    act.add_argument("--text")
    act.set_defaults(run=command_act)

    commands.add_parser("observe", help="Print the current page").set_defaults(run=command_observe)

    finish = commands.add_parser("finish", help="Verify, log, and close Chrome")
    finish.add_argument("--status", required=True, choices=["done", "blocked", "budget", "error", "abandoned"])
    finish.add_argument("--reason")
    finish.set_defaults(run=command_finish)

    learn_command = commands.add_parser("learn", help="Record a person demonstrating a procedure")
    learn_command.add_argument("--name", required=True, help="Runbook name, such as hotel/filter")
    learn_command.add_argument("--url", required=True)
    learn_command.add_argument("--session", default="new", help="new or profile:NAME, to demonstrate signed in")
    chrome_option(learn_command)
    learn_command.add_argument("--max-minutes", type=float, default=30)
    learn_command.add_argument("--headless", action="store_true", help=argparse.SUPPRESS)
    learn_command.set_defaults(run=command_learn)

    profile = commands.add_parser("profile", help="Saved profiles: list, login NAME --url URL, delete NAME")
    profile.add_argument("action", choices=["list", "login", "delete"])
    profile.add_argument("name", nargs="?")
    profile.add_argument("--url")
    chrome_option(profile)
    profile.add_argument("--max-minutes", type=float, default=15)
    profile.set_defaults(run=command_profile)
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
