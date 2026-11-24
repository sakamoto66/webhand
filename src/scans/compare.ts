/**
 * Compare while scrolling: find the item that best meets Claude's criterion in a list longer than the screen,
 * before anything is acted on.
 */

import type { Actor } from "../agent/outcomes.ts";
import type { Recorder } from "../core/metrics.ts";
import { type Action, type ModelCall, type Page, type Plan, PolicyError } from "../core/types.ts";
import { type LoadMore, MAX_PAGES, MAX_SCROLLS, type ScanStop, scanList, scroll } from "./list-scanner.ts";

export { type LoadMore, MAX_PAGES, MAX_SCROLLS, scroll };

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
  /** Scroll position and page when it was chosen, to come back to it. */
  y: number;
  url?: string;
  round: number;
}

export interface Compared {
  criterion: string;
  best: string | null;
  rounds: number;
  stopped: ScanStop;
  /** How many times Claude's control for more items was pressed; absent without --more. */
  pages?: number;
}

export interface Comparer {
  calls: ModelCall[];
  /** Returns a candidate key, KEEP (only with a best), or NONE (only without one). */
  compare(page: Page, plan: Plan, criterion: string, best: Best | null, candidates: Candidate[]): Promise<string>;
}

/** What compareScan needs from the browser beyond the Actor: the text around observed elements. */
export interface Reader extends Actor {
  contexts(nodes: number[]): Promise<Record<string, string>>;
  /** Opens a page the scan has already visited, to come back to the best item. */
  goto?(url: string): Promise<void>;
}

export function describeBest(best: Best | null): string | null {
  if (!best) return null;
  return best.context && best.context !== best.label ? `${best.label} — ${best.context}` : best.label;
}

export async function candidates(browser: Reader, page: Page): Promise<Candidate[]> {
  const seen = new Set<number>();
  const clicks = (page.actions as Action[]).filter((a) => {
    if (a.kind !== "click" || seen.has(a.node)) return false;
    seen.add(a.node);
    return true;
  });
  const texts = await browser.contexts(clicks.map((a) => a.node));
  return clicks.map((action, i) => ({ key: String(i + 1), action, context: texts[String(action.node)] ?? "" }));
}

export async function compareScan(
  browser: Reader,
  comparer: Comparer,
  plan: Plan,
  criterion: string,
  recorder: Recorder,
  options: { attempt?: number; maxScrolls?: number; loadMore?: LoadMore | null } = {},
): Promise<{ compared: Compared; page: Page }> {
  const attempt = options.attempt ?? plan.attempt ?? 1;
  const flush = () => {
    for (const call of comparer.calls) recorder.call(call);
    comparer.calls.length = 0;
  };
  let best: Best | null = null;
  const scan = await scanList(
    browser,
    options.maxScrolls ?? MAX_SCROLLS,
    async (page, round) => {
      const items = await candidates(browser, page);
      const choice = await comparer.compare(page, plan, criterion, best, items);
      flush();
      const chosen = items.find((item) => item.key === choice);
      if (chosen) {
        best = { label: chosen.action.label, context: chosen.context, y: page.scroll.y, url: page.url, round };
      } else if (choice !== KEEP && choice !== NONE) {
        throw new PolicyError(`Comparison choice ${choice} is not offered; nothing was chosen.`);
      }
      recorder.event("compare_round", {
        attempt,
        round,
        y: page.scroll.y,
        height: page.scroll.height,
        candidates: items.length,
        choice: chosen ? "item" : choice,
        best: (best as Best | null)?.label ?? null,
      });
    },
    options.loadMore ?? null,
  );
  const { rounds, stopped } = scan;
  let page = scan.page;
  const found = best as Best | null;
  if (found) {
    if (found.url && found.url !== page.url && browser.goto) {
      await browser.goto(found.url);
      page = await browser.observe();
    }
    if (found.y !== page.scroll.y) {
      await browser.act(scroll(found.y - page.scroll.y), page);
      page = await browser.observe();
    }
    const label = found.label;
    const inView = (page.actions as Action[]).some((a) => a.kind === "click" && a.label === label);
    const reveal = (page.actions as Action[]).find((a) => a.kind === "reveal" && a.label === `Scroll to ${label}`);
    if (!inView && reveal) {
      await browser.act(reveal, page);
      page = await browser.observe();
    }
  }
  const compared: Compared = {
    criterion,
    best: describeBest(found),
    rounds,
    stopped,
    ...(options.loadMore ? { pages: scan.pages } : {}),
  };
  recorder.event("compare_end", { attempt, ...compared, best_label: found?.label ?? null });
  return { compared, page };
}
