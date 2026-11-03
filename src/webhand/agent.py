"""Jev's loop toward Claude's goal: observe, choose, execute. It stops; it never claims success.

The loop returns to Claude only when it cannot continue on its own. The task's verify() decides success.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass

from .metrics import Recorder
from .types import Decision, MutationUncertain, Page, Policy, PolicyError, StalePage

# Why the loop handed control back to Claude.
GOAL_REPORTED = "GOAL_REPORTED"  # Jev chose DONE. Claude checks the page; finish verifies.
BLOCKED = "BLOCKED"
STUCK = "STUCK"  # Three actions in a row did not change the page.
ATTEMPT_BUDGET = "ATTEMPT_BUDGET"
NEEDS_HUMAN = "NEEDS_HUMAN"  # A person acts in the window: sign-in, codes, CAPTCHA, [person] steps.
NEEDS_VALUE = "NEEDS_VALUE"  # A field needs text and none of Claude's values fits.
JEV_FAILED = "JEV_FAILED"  # No usable decision. Nothing was executed.
UNCERTAIN = "UNCERTAIN"  # A mutation may have happened. Never retried, never replanned.
REPLANNABLE = {GOAL_REPORTED, BLOCKED, STUCK, ATTEMPT_BUDGET, NEEDS_VALUE, JEV_FAILED}


@dataclass
class Budget:
    """Per attempt. A replan starts a new attempt with a fresh budget."""

    max_actions: int = 30
    max_decisions: int = 60


MISSING = "missing"  # A history entry for a NOT_VISIBLE choice: nothing ran, but Jev must see it happened.
STALE = "stale"  # A history entry for a choice the browser refused as stale: nothing ran.


def actions_in(history: list[dict], attempt: int) -> list[dict]:
    """Executed actions only; they count against the budget."""
    return [h for h in history if h.get("attempt", 1) == attempt and h["kind"] not in {"human", MISSING, STALE}]


def stuck(history: list[dict], attempt: int = 1) -> bool:
    """Three entries without progress: unchanged pages, targets Jev could not see, or refused stale choices."""
    recent = [h for h in history if h.get("attempt", 1) == attempt and h["kind"] != "human"][-3:]
    return len(recent) == 3 and all(s["page_changed"] is False and s["kind"] != "wait" for s in recent)


def execute(
    browser,
    page: Page,
    decision: Decision,
    history: list[dict],
    recorder: Recorder,
    *,
    decided_by: str,
    attempt: int,
    on_change: Callable[[Page], None] = lambda _page: None,
) -> Page:
    """Runs once. Logged before the next observation so a navigation cannot erase it."""
    action = decision.action
    browser.act(action, page, text=decision.text)
    step = {
        "step": len(history) + 1,
        "attempt": attempt,
        "decided_by": decided_by,
        "confidence": decision.confidence,
        "operation": decision.operation,
        "kind": action["kind"],
        "action": action["label"],
        "text": decision.text,
        "url": page["url"],
        "page_changed": None,
    }
    history.append(step)
    recorder.event("step", **step)
    on_change(page)
    new_page = browser.observe()
    step["page_changed"] = new_page["marker"] != page["marker"]
    recorder.event("step_result", step=step["step"], page_changed=step["page_changed"])
    on_change(new_page)
    return new_page


def run_agent(
    browser,
    policy: Policy,
    plan: dict,
    recorder: Recorder,
    budget: Budget | None = None,
    *,
    history: list[dict] | None = None,
    page: Page | None = None,
    decisions: int = 0,
    on_change: Callable[[Page], None] = lambda _page: None,
    on_decision: Callable[[int], None] = lambda _n: None,
) -> dict:
    """Runs one attempt until an outcome above. history is extended in place."""
    budget = budget or Budget()
    attempt = plan.get("attempt", 1)
    history = [] if history is None else history
    started = time.perf_counter()
    page = page or browser.observe()

    def flush_calls():
        for call in policy.calls:
            recorder.call(call)
        policy.calls.clear()

    def finish(outcome, detail=None, **extra):
        return {
            "outcome": outcome,
            "detail": detail,
            "page": page,
            "actions": len(actions_in(history, attempt)),
            "decisions": decisions,
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
            **extra,
        }

    while True:
        if stuck(history, attempt):
            return finish(STUCK, "three actions without a page change")
        if len(actions_in(history, attempt)) >= budget.max_actions or decisions >= budget.max_decisions:
            return finish(ATTEMPT_BUDGET, f"{len(actions_in(history, attempt))} actions, {decisions} decisions")
        decision, executed = None, len(history)
        try:
            if not browser.fresh(page):
                page = browser.observe()
            decisions += 1
            on_decision(decisions)
            decision = policy.choose(page, plan, history)
            flush_calls()
            if decision.operation == "NOT_VISIBLE":
                entry = {
                    "step": len(history) + 1,
                    "attempt": attempt,
                    "operation": "NOT_VISIBLE",
                    "kind": MISSING,
                    "action": f"Wanted to {decision.wanted}, but the needed element was not listed. Nothing ran",
                    "text": None,
                    "url": page["url"],
                    "page_changed": False,
                }
                history.append(entry)
                recorder.event("not_visible", attempt=attempt, wanted=decision.wanted, confidence=decision.confidence)
                on_change(page)
                continue
            if decision.action is None:
                if not browser.fresh(page):
                    continue
                outcome = {"DONE": GOAL_REPORTED, "NEEDS_HUMAN": NEEDS_HUMAN}.get(decision.operation, BLOCKED)
                return finish(outcome, f"Jev chose {decision.operation}")
            if decision.action["kind"] == "fill" and decision.text is None:
                field = {k: decision.action.get(k) for k in ("label", "role", "value")}
                return finish(NEEDS_VALUE, "no value from the plan fits this field", field=field)
            page = execute(
                browser, page, decision, history, recorder, decided_by=policy.name, attempt=attempt, on_change=on_change
            )
        except StalePage as error:
            observed, page = page, browser.observe()
            # Only a refused action is noted. A step that ran is already in history, whatever failed after it.
            if decision is not None and decision.action is not None and len(history) == executed:
                entry = {
                    "step": len(history) + 1,
                    "attempt": attempt,
                    "operation": "STALE",
                    "kind": STALE,
                    "action": f"{decision.operation} {decision.action['label']!r} did not run: {error}",
                    "text": None,
                    "url": observed["url"],
                    # Unchanged: the same choice would be refused again, so it counts toward STUCK.
                    "page_changed": page["marker"] != observed["marker"],
                }
                history.append(entry)
                recorder.event(
                    "stale",
                    attempt=attempt,
                    wanted=decision.operation,
                    target=decision.action["label"],
                    reason=str(error),
                    page_changed=entry["page_changed"],
                )
            on_change(page)
        except PolicyError as error:
            return finish(JEV_FAILED, str(error))
        except MutationUncertain as error:
            return finish(UNCERTAIN, f"mutation uncertain: {error}")
        finally:
            flush_calls()
