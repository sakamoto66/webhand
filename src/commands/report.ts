import * as agent from "../agent.ts";
import { show, toJson } from "../format.ts";
import { headline, recentActions, render } from "../output.ts";
import type * as session from "../session.ts";
import type { HistoryEntry, Page } from "../types.ts";

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

/** Why the run came back, from the log of this attempt only. No page text. */
function diagnose(state: session.State, outcome: string): string {
  const status = state.page?.status as { kind?: string } | undefined;
  if (status?.kind === "check") return "the page is a bot check or CAPTCHA; a person must pass it";
  if (status?.kind === "sign_in") return "the page asks for a sign-in; a person must sign in";
  if (status?.kind === "error") return "the page is an error page";
  if (status?.kind === "dialog") return "a dialog covers the page";
  const rows = (state.history as HistoryEntry[]).filter((h) => (h.attempt ?? 1) === state.plan.attempt).slice(-3);
  const count = (kind: string) => rows.filter((h) => h.kind === kind).length;
  if (outcome === agent.STUCK) {
    if (agent.looping(state.history as HistoryEntry[], state.plan.attempt)) {
      return "Jev scrolled up and down three times and chose nothing: what it needs may not be on this page, or is elsewhere on it";
    }
    if (count("stale")) return "the last choices were refused as stale: the page keeps changing under the target";
    if (count("missing")) return `Jev could not find the element it needs in what was offered${unseenHint(state.page)}`;
    return "the last three actions did not change the page";
  }
  if (outcome === agent.READ_ONLY) {
    return "the session is read-only and Jev chose an action it refuses; nothing ran. Answer with another way that only reads, or finish";
  }
  if (outcome === agent.GOAL_REPORTED) return "Jev thinks the goal is met and asks Claude to check the page";
  if (outcome === agent.JEV_FAILED) return "Jev gave no usable decision; nothing was executed";
  const handed =
    "Jev handed the decision to Claude: the page is not what the plan expects, nothing offered fits, or the operation cannot be undone";
  return `${handed}${unseenHint(state.page)}`;
}

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
  print(`${recentActions(state)}\n${render(state.page)}`);
  if (state.plan.flow === "v2" && ANSWERABLE.includes(outcome)) {
    print(`WHY: ${diagnose(state, outcome)}`);
    print(
      "NEXT: answer --note '...' [--value 'LABEL=VALUE'] [--url URL] continues this attempt; replan changes the plan; " +
        "if it cannot be done, ask the person with AskUserQuestion; finish",
    );
    return OK;
  }
  if (outcome === agent.GOAL_REPORTED) {
    print("Check the page against the goal. If it is met: finish --status done. Otherwise: replan");
  } else if (outcome === agent.JEV_FAILED) {
    print("Nothing was executed. Run again, replan, or act");
  } else {
    print("NEXT: replan --reason '...' [--restart], act, or finish");
  }
  return OK;
}
