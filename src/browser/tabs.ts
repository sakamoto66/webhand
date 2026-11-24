/** Tab tracking, remembered-tab persistence across CLI commands, tab offering, and tab switching. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { BrowserContext, CDPSession, Page as PlaywrightPage } from "playwright-core";
import { type Action, type Page, StalePage } from "../core/types.ts";
import { home as sessionHome, tabPath } from "../storage/session.ts";

const MAX_TAB_TITLE = 60;

/** A tab's title as the model sees it: one line, clipped. Page text, so never instructions. */
function tabTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, MAX_TAB_TITLE);
}

export class TabManager {
  /** Lightpanda lists a placeholder tab that is no page: nothing can attach to it and it hangs on close. */
  private placeholder: PlaywrightPage | null = null;

  async findPlaceholder(context: BrowserContext): Promise<void> {
    for (const page of context.pages()) {
      if ((await this.tabId(context, page)) === null) this.placeholder = page;
    }
  }

  openTabs(context: BrowserContext): PlaywrightPage[] {
    return context.pages().filter((page) => !page.isClosed() && page !== this.placeholder);
  }

  private async tabId(context: BrowserContext, page: PlaywrightPage): Promise<string | null> {
    try {
      const session = await context.newCDPSession(page);
      try {
        const { targetInfo } = await session.send("Target.getTargetInfo");
        return targetInfo.targetId;
      } finally {
        await session.detach().catch(() => {});
      }
    } catch {
      return null;
    }
  }

  /** The tab the last command left the run on; the first tab when none was kept or it is gone. */
  async rememberedTab(context: BrowserContext): Promise<PlaywrightPage> {
    const pages = this.openTabs(context);
    const file = tabPath();
    if (pages.length > 1 && existsSync(file)) {
      const wanted = readFileSync(file, "utf8").trim();
      for (const page of pages) if ((await this.tabId(context, page)) === wanted) return page;
    }
    return pages[0];
  }

  async rememberTab(
    context: BrowserContext,
    page: PlaywrightPage,
    attached: boolean,
    keepsTab: boolean,
  ): Promise<void> {
    if (!attached || !keepsTab) return;
    const id = await this.tabId(context, page);
    if (id === null) return;
    mkdirSync(sessionHome(), { recursive: true });
    writeFileSync(tabPath(), id, { encoding: "utf8", mode: 0o600 });
  }

  /** The other tabs, as controls Jev can choose by number. Offered only when more than one tab is open. */
  async offerTabs(context: BrowserContext, currentPage: PlaywrightPage, state: Page): Promise<void> {
    const open = this.openTabs(context);
    if (open.length < 2) return;
    const current = open.indexOf(currentPage);
    const titles = await Promise.all(open.map((page) => page.title().catch(() => "")));
    state.tabs = { count: open.length, current: current + 1 };
    open.forEach((_, i) => {
      if (i === current) return;
      const title = tabTitle(titles[i]);
      const control = { id: `tab_${i + 1}`, kind: "tab", label: `Switch to tab ${i + 1}: ${title}`, tab: i + 1, title };
      state.actions.splice(state.actions.length - 1, 0, control); // Before "wait", which stays last.
    });
  }

  /** Makes another open tab the one the run observes and acts on. Nothing on any page changes. */
  async switchTab(
    context: BrowserContext,
    currentPage: PlaywrightPage,
    currentCdp: CDPSession | undefined,
    action: Action,
    page: Page,
    attached: boolean,
    keepsTab: boolean,
  ): Promise<{ page: PlaywrightPage; cdp: CDPSession }> {
    const open = this.openTabs(context);
    const tabs = page.tabs;
    if (!tabs || open.length !== tabs.count || open[tabs.current - 1] !== currentPage) {
      throw new StalePage("Tabs changed since this decision", ["tabs"]);
    }
    const target = open[action.tab - 1];
    if (!target || target === currentPage) throw new StalePage("Tab is gone", ["tab_gone"]);
    const title = tabTitle(await target.title().catch(() => ""));
    if (title !== action.title) throw new StalePage("Tab changed since this decision", ["tab_title"]);
    let next: CDPSession;
    try {
      next = await context.newCDPSession(target);
      // Bringing a tab to the front only matters with a window. An engine without the method (Obscura) still switches.
      await target.bringToFront().catch((error: Error) => {
        if (!/Unknown .*method|not (implemented|supported)|wasn't found/i.test(error.message)) throw error;
      });
      await currentCdp?.detach().catch(() => {});
    } catch {
      throw new StalePage("Tab could not be switched to", ["tab_gone"]);
    }
    await this.rememberTab(context, target, attached, keepsTab);
    return { page: target, cdp: next };
  }

  /** A tab that closed itself (a popup done with its work) leaves the run on the last tab still open. */
  async leaveClosedTab(
    context: BrowserContext,
    currentPage: PlaywrightPage,
    attached: boolean,
    keepsTab: boolean,
  ): Promise<{ page: PlaywrightPage; cdp: CDPSession } | null> {
    if (!currentPage.isClosed()) return null;
    const open = this.openTabs(context);
    if (open.length === 0) throw new StalePage("Every tab is closed");
    const nextPage = open[open.length - 1];
    const nextCdp = await context.newCDPSession(nextPage);
    await this.rememberTab(context, nextPage, attached, keepsTab);
    return { page: nextPage, cdp: nextCdp };
  }
}
