/** Shared scrolling list scanner used by both compareScan and collectScan. */

import type { Actor } from "../agent/outcomes.ts";
import { sleep } from "../core/format.ts";
import type { Action, Page } from "../core/types.ts";

// Screens a scan goes through.
export const MAX_SCROLLS = 100;
/** How many times a scan may press Claude's control for more items (--more). */
export const MAX_PAGES = 10;
/** How long the bottom of the page is watched for more items to load. */
const GROW_WAIT_MS = 2000;
const GROW_POLL_MS = 250;
/** Each scroll leaves this much of the last screen in view, so an item is never cut in half unseen. */
const OVERLAP_PX = 120;

export type ScanStop = "limit" | "bottom" | "pages";

/** Presses Claude's control for more items; returns the page with more, or null when there is none. */
export type LoadMore = (page: Page) => Promise<Page | null>;

/** A scan's own scroll. It is not a decision by Jev, so it is not checked for staleness (scan: true). */
export function scroll(delta: number): Action {
  return { id: "scroll", kind: "scroll", label: "Scroll", delta, scan: true };
}

const bottom = (page: Page) => page.scroll.y + page.h >= page.scroll.height - 2;

/** Waits at the bottom for the page to grow. Returns the grown page, or null when nothing more loaded. */
async function grown(browser: Actor, page: Page): Promise<Page | null> {
  for (let waited = 0; waited < GROW_WAIT_MS; waited += GROW_POLL_MS) {
    await sleep(GROW_POLL_MS);
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
  stopped: ScanStop;
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
    const end = (stopped: ScanStop) => ({ rounds, stopped, page, startY, startUrl, pages });
    if (rounds >= maxScrolls) return end("limit");
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
