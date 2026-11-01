"""The loop: observe, choose, execute. It stops; it never claims success. Tasks verify outcomes."""

import time
from dataclasses import dataclass

from .metrics import Recorder
from .policies.base import field_context
from .types import MutationUncertain, Policy, PolicyError, StalePage


def stuck(history: list[dict]) -> bool:
    recent = history[-3:]
    return len(recent) == 3 and all(s["page_changed"] is False and s["kind"] != "wait" for s in recent)


@dataclass
class Budget:
    max_actions: int = 30
    max_decisions: int = 60


def run_agent(browser, policy: Policy, goal: str, recorder: Recorder, budget: Budget | None = None) -> dict:
    """Returns status: done, blocked, budget, or error. Only the task's verifier decides success."""
    budget = budget or Budget()
    started = time.perf_counter()
    history: list[dict] = []
    decisions = 0
    pending_text = None
    page = browser.observe()

    def flush_calls():
        for call in policy.calls:
            recorder.call(call)
        policy.calls.clear()

    def finish(status, reason=None):
        return {
            "status": status,
            "reason": reason,
            "actions": len(history),
            "decisions": decisions,
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
        }

    while True:
        if len(history) >= budget.max_actions or decisions >= budget.max_decisions:
            return finish("budget", f"{len(history)} actions, {decisions} decisions")
        try:
            if not browser.fresh(page):
                page = browser.observe()
            decisions += 1
            decision = policy.choose(page, goal, history)
            if decision.action is None:
                if not browser.fresh(page):
                    continue
                return finish("done" if decision.operation == "DONE" else "blocked")

            action, text = decision.action, None
            if action["kind"] == "fill":
                if not browser.fresh(page):
                    continue
                context = field_context(goal, action, page, history)
                if pending_text and pending_text[0] == context:
                    text = pending_text[1]
                else:
                    text = policy.text(context)
                    pending_text = (context, text)
            browser.act(action, page, text=text)
        except StalePage:
            page = browser.observe()
            continue
        except PolicyError as error:
            return finish("error", str(error))
        except MutationUncertain as error:
            return finish("error", f"mutation uncertain: {error}")
        finally:
            flush_calls()

        # Logged before observing, so a navigation during observe cannot erase the action.
        pending_text = None
        step = {
            "step": len(history) + 1,
            "operation": decision.operation,
            "kind": action["kind"],
            "action": action["label"],
            "text": text,
            "url": page["url"],
            "page_changed": None,
        }
        history.append(step)
        recorder.event("step", **step)
        previous = page["marker"]
        page = browser.observe()
        step["page_changed"] = page["marker"] != previous
        recorder.event("step_result", step=step["step"], page_changed=step["page_changed"])
        if stuck(history):
            return finish("blocked", "three actions without a page change")
