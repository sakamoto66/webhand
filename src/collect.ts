/**
 * Collect while scrolling: find every item of a list longer than the screen that meets Claude's condition.
 *
 * webhand scrolls, from the top, one screen at a time (the same scan as compare.ts); Jev only judges. After
 * each scroll, the list and table items in view that were not seen before are asked about, one question each:
 * does it meet the condition? The items that do are kept as text, since they may leave the page. Nothing is
 * clicked or typed. Claude gets the items and writes the answer from them.
 */

import type { Actor } from "./agent.ts";
import { MAX_SCROLLS, scanList } from "./compare.ts";
import type { Recorder } from "./metrics.ts";
import type { ModelCall, Page, Plan } from "./types.ts";

/** Items shown to Claude; the count of all matches is kept beyond it. */
export const MAX_COLLECTED = 100;
/** Items asked about in one Jev request. */
const BATCH = 40;

export const MATCH = "MATCH";
export const NO = "NO";

export interface Row {
  key: string;
  text: string;
}

export interface Collected {
  criterion: string;
  /** The matching items, at most MAX_COLLECTED. */
  items: string[];
  matched: number;
  seen: number;
  rounds: number;
  stopped: "limit" | "bottom";
}

export interface Collector {
  calls: ModelCall[];
  /** Returns the keys of the rows that meet the condition. */
  collect(page: Page, plan: Plan, criterion: string, rows: Row[]): Promise<Set<string>>;
}

/** What collectScan needs from the browser beyond the Actor: the items in view. */
export interface RowReader extends Actor {
  rows(): Promise<string[]>;
}

export async function collectScan(
  browser: RowReader,
  collector: Collector,
  plan: Plan,
  criterion: string,
  recorder: Recorder,
  options: { attempt?: number; maxScrolls?: number } = {},
): Promise<{ collected: Collected; page: Page }> {
  const attempt = options.attempt ?? plan.attempt ?? 1;
  const seen = new Set<string>();
  const items: string[] = [];
  let matched = 0;
  const scan = await scanList(browser, options.maxScrolls ?? MAX_SCROLLS, async (page, round) => {
    const texts = await browser.rows();
    const fresh = texts.filter((text) => !seen.has(text) && seen.add(text));
    let found = 0;
    for (let start = 0; start < fresh.length; start += BATCH) {
      const rows = fresh.slice(start, start + BATCH).map((text, i) => ({ key: String(start + i + 1), text }));
      const keys = await collector.collect(page, plan, criterion, rows);
      for (const call of collector.calls) recorder.call(call);
      collector.calls.length = 0;
      for (const row of rows) {
        if (!keys.has(row.key)) continue;
        found += 1;
        if (items.length < MAX_COLLECTED) items.push(row.text);
      }
    }
    matched += found;
    recorder.event("collect_round", {
      attempt,
      round,
      y: page.scroll.y,
      height: page.scroll.height,
      rows: texts.length,
      new: fresh.length,
      matched: found,
    });
  });
  const collected: Collected = {
    criterion,
    items,
    matched,
    seen: seen.size,
    rounds: scan.rounds,
    stopped: scan.stopped,
  };
  const { items: _items, ...counts } = collected;
  recorder.event("collect_end", { attempt, ...counts });
  return { collected, page: scan.page };
}
