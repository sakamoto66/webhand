import * as agent from "../agent/index.ts";
import { show, toJson } from "../core/format.ts";
import type { HistoryEntry, Page } from "../core/types.ts";
import { headline, recentActions, render } from "../output.ts";
import type * as session from "../storage/session.ts";
import { OK, print, UNCERTAIN } from "./context.ts";
import { attemptLabel } from "./shared.ts";

/** Outcomes after which `answer` continues the same attempt (v2). */
export const ANSWERABLE: string[] = [
  agent.ESCALATE,
  agent.STUCK,
  agent.BLOCKED,
  agent.GOAL_REPORTED,
  agent.JEV_FAILED,
  agent.READ_ONLY,
];

const PAGE_STATUS_DIAGNOSIS: Record<string, string> = {
  check: "the page is a bot check or CAPTCHA; a person must pass it",
  sign_in: "the page asks for a sign-in; a person must sign in",
  error: "the page is an error page",
  dialog: "a dialog covers the page",
};

const OUTCOME_DIAGNOSIS: Record<string, string> = {
  [agent.READ_ONLY]:
    "the session is read-only and Jev chose an action it refuses; nothing ran. Answer with another way that only reads, or finish",
  [agent.GOAL_REPORTED]: "Jev thinks the goal is met and asks Claude to check the page",
  [agent.JEV_FAILED]: "Jev gave no usable decision; nothing was executed",
};

const DEFAULT_NEXT_HINT = "NEXT: replan --reason '...' [--restart], act, or finish";
const OUTCOME_NEXT_HINTS: Record<string, string> = {
  [agent.GOAL_REPORTED]: "Check the page against the goal. If it is met: finish --status done. Otherwise: replan",
  [agent.JEV_FAILED]: "Nothing was executed. Run again, replan, or act",
};

/** v2: parts of the page webhand cannot see into, said plainly so that Claude looks for another way. */
function unseenHint(page: Page): string {
  if (!agent.unseenParts(page)) return "";
  const unseen = (page.status?.unseen ?? {}) as Record<string, number>;
  return (
    `. The page has ${unseen.canvases ?? 0} canvas, ${unseen.frames ?? 0} frame, and ${unseen.objects ?? 0} plugin parts ` +
    "whose content webhand cannot see: what Jev needs may be inside one. Answering cannot reveal it; look for another way " +
    "(a list or text version, another page, a keyboard route) or ask the person"
  );
}

function diagnoseStuck(state: session.State): string {
  const history = state.history as HistoryEntry[];
  const attempt = state.plan.attempt;
  if (agent.looping(history, attempt)) {
    return "Jev scrolled up and down three times and chose nothing: what it needs may not be on this page, or is elsewhere on it";
  }
  const recent = history.filter((h) => (h.attempt ?? 1) === attempt).slice(-3);
  if (recent.some((h) => h.kind === "stale")) {
    return "the last choices were refused as stale: the page keeps changing under the target";
  }
  if (recent.some((h) => h.kind === "missing")) {
    return `Jev could not find the element it needs in what was offered${unseenHint(state.page)}`;
  }
  return "the last three actions did not change the page";
}

/** Why the run came back, from the log of this attempt only. No page text. */
function diagnose(state: session.State, outcome: string): string {
  const pageKind = (state.page?.status as { kind?: string } | undefined)?.kind;
  if (pageKind && pageKind in PAGE_STATUS_DIAGNOSIS) return PAGE_STATUS_DIAGNOSIS[pageKind];
  if (outcome === agent.STUCK) return diagnoseStuck(state);
  if (outcome in OUTCOME_DIAGNOSIS) return OUTCOME_DIAGNOSIS[outcome];
  const handed =
    "Jev handed the decision to Claude: the page is not what the plan expects, nothing offered fits, or the operation cannot be undone";
  return `${handed}${unseenHint(state.page)}`;
}

const REPORT_MAX_OPTIONS = 12;

/** What Claude needs for this outcome, and nothing more. */
export function report(state: session.State, result: agent.AgentResult): number {
  const outcome = result.outcome;
  print(`OUTCOME ${outcome} (${attemptLabel(state)}): ${show(result.detail)}`);
  if (outcome === agent.UNCERTAIN) {
    print("Do not repeat or replan. Run: webhand finish --status error");
    return UNCERTAIN;
  }
  if (outcome === agent.NEEDS_HUMAN) {
    print(`${headline(state.page)}\nAsk the person to do this in the Chrome window, then: run --human-done`);
    return OK;
  }
  if (outcome === agent.NEEDS_VALUE) {
    print(`FIELD: ${toJson(result.field)}`);
    print("Give the value with: run --value 'LABEL=VALUE'. Never invent personal data; ask the person");
    return OK;
  }
  const pageView =
    outcome === agent.GOAL_REPORTED
      ? render(state.page, { elements: false })
      : render(state.page, { offscreenElements: false, maxOptions: REPORT_MAX_OPTIONS });
  print(`${recentActions(state)}\n${pageView}`);
  if (state.plan.flow === "v2" && ANSWERABLE.includes(outcome)) {
    print(`WHY: ${diagnose(state, outcome)}`);
    print(
      "NEXT: answer --note '...' [--value 'LABEL=VALUE'] [--url URL] continues this attempt; replan changes the plan; " +
        "if it cannot be done, ask the person with AskUserQuestion; finish",
    );
    return OK;
  }
  print(OUTCOME_NEXT_HINTS[outcome] ?? DEFAULT_NEXT_HINT);
  return OK;
}
