/**
 * A click that sent a request and changed nothing is not pressed again: the server may have acted on it, or refused it,
 * with nothing on the page to show which. Without a request, a press that shows nothing is ordinary (a counter).
 */

import type { Action, HistoryEntry, Page } from "../core/types.ts";

const keyOf = (action: Action): string => JSON.stringify([action.node ?? action.id ?? null, action.label ?? null]);

/**
 * The clicks of one run that sent a request and left the page as it was, for as long as the URL stays. Other changes
 * on the page do not forget them: a menu opened and closed between two presses says nothing about the first one.
 */
export class NoEffectClicks {
  private url: unknown = null;
  private readonly keys = new Set<string>();

  /** After an action ran on `before`: remembered when it is a click that sent a request and changed nothing. */
  note(action: Action, step: HistoryEntry, before: Page, sent: boolean): void {
    if (action.kind !== "click" || step.page_changed || !sent) return;
    this.forgetOtherUrls(before);
    this.url = before.url;
    this.keys.add(keyOf(action));
  }

  /** Whether this action would press such a control again. */
  repeats(action: Action, now: Page): boolean {
    this.forgetOtherUrls(now);
    return action.kind === "click" && this.keys.has(keyOf(action));
  }

  private forgetOtherUrls(page: Page): void {
    if (page.url !== this.url) this.keys.clear();
  }
}
