/**
 * Compare while scrolling: find the item that best meets Claude's criterion in a list longer than the screen,
 * before anything is acted on.
 *
 * webhand scrolls, from the top, one screen at a time; Jev only compares. After each scroll Jev chooses among
 * the items in view and the best one so far (kept as text, since it may have left the page), or keeps it.
 * The scan stops at 20 scrolls, or at the bottom of the page once waiting adds nothing more. Nothing is clicked
 * or typed. Afterwards the page is scrolled back to where the best item was, and the normal loop acts on it.
 */

import type { Actor } from "./agent.ts";
import type { Recorder } from "./metrics.ts";
import { type Action, type ModelCall, type Page, type Plan, PolicyError } from "./types.ts";

export const MAX_SCROLLS = 20;
/** How long the bottom of the page is watched for more items to load. */
const GROW_WAIT_MS = 2000;
const GROW_POLL_MS = 250;
/** Each scroll leaves this much of the last screen in view, so an item is never cut in half unseen. */
const OVERLAP_PX = 120;

export const KEEP = "KEEP";
export const NONE = "NONE";

/** An item the comparison can choose: an element in view and the text of the row, card, or item it is in. */
export interface Candidate {
  key: string;
  action: Action;
  context: string;
}

export interface Best {
  label: string;
  context: string;
  /** Scroll position when it was chosen, to come back to it. */
  y: number;
  round: number;
}

export interface Compared {
  criterion: string;
  best: string | null;
  rounds: number;
  stopped: "limit" | "bottom";
}

export interface Comparer {
  calls: ModelCall[];
  /** Returns a candidate key, KEEP (only with a best), or NONE (only without one). */
  compare(page: Page, plan: Plan, criterion: string, best: Best | null, candidates: Candidate[]): Promise<string>;
}

/** What compareScan needs from the browser beyond the Actor: the text around observed elements. */
export interface Reader extends Actor {
  contexts(nodes: number[]): Promise<Record<string, string>>;
}

export function describeBest(best: Best | null): string | null {
  if (!best) return null;
  return best.context && best.context !== best.label ? `${best.label} — ${best.context}` : best.label;
}

async function candidates(browser: Reader, page: Page): Promise<Candidate[]> {
  const seen = new Set<number>();
  const clicks = (page.actions as Action[]).filter((a) => {
    if (a.kind !== "click" || seen.has(a.node)) return false;
    seen.add(a.node);
    return true;
  });
  const texts = await browser.contexts(clicks.map((a) => a.node));
  return clicks.map((action, i) => ({ key: String(i + 1), action, context: texts[String(action.node)] ?? "" }));
}

function scroll(delta: number): Action {
  return { id: "scroll", kind: "scroll", label: "Scroll", delta };
}

const bottom = (page: Page) => page.scroll.y + page.h >= page.scroll.height - 2;

/** Waits at the bottom for the page to grow. Returns the grown page, or null when nothing more loaded. */
async function grown(browser: Reader, page: Page): Promise<Page | null> {
  for (let waited = 0; waited < GROW_WAIT_MS; waited += GROW_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, GROW_POLL_MS));
    const next = await browser.observe();
    if (next.scroll.height > page.scroll.height) return next;
  }
  return null;
}

export async function compareScan(
  browser: Reader,
  comparer: Comparer,
  plan: Plan,
  criterion: string,
  recorder: Recorder,
  options: { attempt?: number; maxScrolls?: number } = {},
): Promise<{ compared: Compared; page: Page }> {
  const attempt = options.attempt ?? plan.attempt ?? 1;
  const maxScrolls = options.maxScrolls ?? MAX_SCROLLS;
  const flush = () => {
    for (const call of comparer.calls) recorder.call(call);
    comparer.calls.length = 0;
  };
  let page = await browser.observe();
  if (page.scroll.y > 0) {
    await browser.act(scroll(-page.scroll.y), page);
    page = await browser.observe();
  }
  let best: Best | null = null;
  let rounds = 0;
  let stopped: Compared["stopped"];
  while (true) {
    const items = await candidates(browser, page);
    const choice = await comparer.compare(page, plan, criterion, best, items);
    flush();
    const chosen = items.find((item) => item.key === choice);
    if (chosen) {
      best = { label: chosen.action.label, context: chosen.context, y: page.scroll.y, round: rounds };
    } else if (choice !== KEEP && choice !== NONE) {
      throw new PolicyError(`Comparison choice ${choice} is not offered; nothing was chosen.`);
    }
    recorder.event("compare_round", {
      attempt,
      round: rounds,
      y: page.scroll.y,
      height: page.scroll.height,
      candidates: items.length,
      choice: chosen ? "item" : choice,
      best: best?.label ?? null,
    });
    if (rounds >= maxScrolls) {
      stopped = "limit";
      break;
    }
    if (bottom(page)) {
      const next = await grown(browser, page);
      if (!next) {
        stopped = "bottom";
        break;
      }
      page = next;
    }
    await browser.act(scroll(Math.max(100, page.h - OVERLAP_PX)), page);
    rounds += 1;
    page = await browser.observe();
  }
  if (best) {
    if (best.y !== page.scroll.y) {
      await browser.act(scroll(best.y - page.scroll.y), page);
      page = await browser.observe();
    }
    const label = best.label;
    const inView = (page.actions as Action[]).some((a) => a.kind === "click" && a.label === label);
    const reveal = (page.actions as Action[]).find((a) => a.kind === "reveal" && a.label === `Scroll to ${label}`);
    if (!inView && reveal) {
      await browser.act(reveal, page);
      page = await browser.observe();
    }
  }
  const compared: Compared = { criterion, best: describeBest(best), rounds, stopped };
  recorder.event("compare_end", { attempt, ...compared, best_label: best?.label ?? null });
  return { compared, page };
}
