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

// Screens a scan goes through. 20 cut long lists short in BU Bench (round gv1: a list of 200 rows, read to
// about 105, three times); 100 screens still stop an endless feed.
export const MAX_SCROLLS = 100;
/** How many times a scan may press Claude's control for more items (--more). */
export const MAX_PAGES = 10;
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
  /** Scroll position and page when it was chosen, to come back to it. */
  y: number;
  url?: string;
  round: number;
}

export interface Compared {
  criterion: string;
  best: string | null;
  rounds: number;
  stopped: "limit" | "bottom" | "pages";
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

/** Presses Claude's control for more items; returns the page with more, or null when there is none. */
export type LoadMore = (page: Page) => Promise<Page | null>;

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

/** A scan's own scroll. It is not a decision by Jev, so it is not checked for staleness (scan: true). */
export function scroll(delta: number): Action {
  return { id: "scroll", kind: "scroll", label: "Scroll", delta, scan: true };
}

const bottom = (page: Page) => page.scroll.y + page.h >= page.scroll.height - 2;

/** Waits at the bottom for the page to grow. Returns the grown page, or null when nothing more loaded. */
async function grown(browser: Actor, page: Page): Promise<Page | null> {
  for (let waited = 0; waited < GROW_WAIT_MS; waited += GROW_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, GROW_POLL_MS));
    const next = await browser.observe();
    if (next.scroll.height > page.scroll.height) return next;
  }
  return null;
}

/**
 * Scrolls through the page from the top one screen at a time, calling onScreen on each, until the scroll
 * limit, or the bottom once waiting there adds nothing more. Only scrolls; nothing is clicked or typed, except
 * by loadMore: it is asked where the main list ends (when the browser can tell) and at the bottom.
 */
export async function scanList(
  browser: Actor & { listEnd?(): Promise<number | null> },
  maxScrolls: number,
  onScreen: (page: Page, round: number) => Promise<void>,
  loadMore: LoadMore | null = null,
): Promise<{
  rounds: number;
  stopped: Compared["stopped"];
  page: Page;
  startY: number;
  startUrl: string;
  pages: number;
}> {
  let page = await browser.observe();
  const startY = page.scroll.y;
  const startUrl = page.url;
  let pages = 0;
  if (page.scroll.y > 0) {
    await browser.act(scroll(-page.scroll.y), page);
    page = await browser.observe();
  }
  let rounds = 0;
  let asked = "";
  while (true) {
    await onScreen(page, rounds);
    const end = (stopped: Compared["stopped"]) => ({ rounds, stopped, page, startY, startUrl, pages });
    if (rounds >= maxScrolls) return end("limit");
    // The control for more items is usually right below the list, which may be far above the bottom of the
    // page. Where the list ends, it is looked for once, before scrolling past it; then again at the bottom.
    const here = `${page.url}|${page.scroll.height}`;
    let listEnd = loadMore && !bottom(page) && asked !== here ? await browser.listEnd?.() : null;
    if (listEnd != null && listEnd > page.h) listEnd = null;
    if (bottom(page) || listEnd != null) {
      const next = await grown(browser, page);
      if (!next) {
        if (!loadMore) return end("bottom");
        if (pages >= MAX_PAGES) return end("pages");
        if (listEnd != null && listEnd > page.h / 2) {
          // Bring what is below the list into view.
          await browser.act(scroll(Math.round(listEnd - page.h / 3)), page);
          page = await browser.observe();
        }
        asked = `${page.url}|${page.scroll.height}`;
        const loaded = await loadMore(page);
        if (loaded) {
          // More items, on this page or the next one: look at the screen as it is now before scrolling on.
          pages += 1;
          rounds += 1;
          page = loaded;
          continue;
        }
        if (bottom(page)) return end("bottom");
      } else {
        page = next;
      }
    }
    await browser.act(scroll(Math.max(100, page.h - OVERLAP_PX)), page);
    rounds += 1;
    page = await browser.observe();
  }
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
      // The best item was on an earlier page: open that page again (it was already visited).
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
