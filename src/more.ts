/**
 * More items: a list that shows more only when a control is pressed (a load-more button, a next-page link).
 *
 * Claude names the control (--more "Next page"). Where a compare or collect scan reaches the end of the list,
 * and at the bottom once waiting adds nothing, Jev chooses which element in view is that control, or NONE;
 * webhand presses it once and waits for the page to show more. Pressing is an action: it is never repeated, and
 * an uncertain result stops the scan with MutationUncertain.
 */

import { type Candidate, candidates, type LoadMore, NONE, type Reader } from "./compare.ts";
import type { Recorder } from "./metrics.ts";
import { type Action, type ModelCall, type Page, type Plan, PolicyError, StalePage } from "./types.ts";

const SETTLE_MS = 3000;
const SETTLE_POLL_MS = 250;

export interface MoreChooser {
  calls: ModelCall[];
  /** Returns the key of the element that is Claude's control, or NONE. */
  more(page: Page, plan: Plan, control: string, candidates: Candidate[]): Promise<string>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the page to change after the control was pressed: a new page, more content, or other text. */
async function changed(browser: Reader, before: Page): Promise<Page | null> {
  for (let waited = 0; waited < SETTLE_MS; waited += SETTLE_POLL_MS) {
    await sleep(SETTLE_POLL_MS);
    let page: Page;
    try {
      page = await browser.observe();
    } catch (error) {
      if (error instanceof StalePage) continue; // Still navigating.
      throw error;
    }
    if (page.url !== before.url || page.scroll.height > before.scroll.height || page.text !== before.text) {
      return page;
    }
  }
  return null;
}

export function loadMore(
  browser: Reader,
  chooser: MoreChooser,
  plan: Plan,
  control: string,
  recorder: Recorder,
  attempt: number,
  /** A read-only session: why this action may not be pressed, or null. */
  refuse: ((action: Action) => string | null) | null = null,
): LoadMore {
  return async (page) => {
    const items = await candidates(browser, page);
    const choice = items.length ? await chooser.more(page, plan, control, items) : NONE;
    for (const call of chooser.calls) recorder.call(call);
    chooser.calls.length = 0;
    const chosen = items.find((item) => item.key === choice);
    if (!chosen && choice !== NONE) throw new PolicyError(`Choice ${choice} is not offered; nothing was pressed.`);
    if (!chosen) {
      // How many elements were offered tells "no such control in view" (0) from "Jev found none of them" (>0).
      recorder.event("more", { attempt, url: page.url, pressed: null, offered: items.length });
      return null;
    }
    const refused = refuse?.(chosen.action) ?? null;
    if (refused) {
      recorder.event("read_only_refused", { attempt, kind: chosen.action.kind, target: chosen.action.label });
      throw new PolicyError(`read-only: ${refused}; nothing was pressed.`);
    }
    await browser.act(chosen.action, page);
    const next = await changed(browser, page);
    recorder.event("more", {
      attempt,
      url: page.url,
      pressed: chosen.action.label,
      changed: next === null ? "nothing" : next.url !== page.url ? "page" : "content",
    });
    return next;
  };
}
