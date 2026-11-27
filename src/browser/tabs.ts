/** Tab tracking, remembered-tab persistence across CLI commands, tab offering, and tab switching. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { BrowserContext, CDPSession, Page as PlaywrightPage } from "playwright-core";
import { sleep } from "../core/format.ts";
import { type Action, type Page, StalePage } from "../core/types.ts";
import { home as sessionHome, tabPath } from "../storage/session.ts";

const MAX_TAB_TITLE = 60;
/** The longest an observation waits for a new tab that is not listed yet. */
const NEW_TAB_WAIT_MS = 5000;

/** A tab's title as the model sees it: one line, clipped. Page text, so never instructions. */
function tabTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, MAX_TAB_TITLE);
}

export class TabManager {
  /** Lightpanda lists a placeholder tab that is no page: nothing can attach to it and it hangs on close. */
  private placeholder: PlaywrightPage | null = null;
  private targets: CDPSession | null = null;
  private readonly ids = new WeakMap<PlaywrightPage, string>();
  /** Unlisted tabs that are not waited for again. */
  private readonly givenUp = new Set<string>();

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

  /**
   * The tabs the browser has that the context does not list. Playwright lists a new tab only once its server has
   * answered. Empty when the browser cannot say.
   */
  private async unlistedTabs(context: BrowserContext): Promise<string[]> {
    try {
      this.targets ??= (await context.browser()?.newBrowserCDPSession()) ?? null;
      if (!this.targets) return [];
      const { targetInfos } = await this.targets.send("Target.getTargets");
      // Read after the targets, so a tab listed in between counts as listed.
      const listed = new Set<string>();
      for (const page of this.openTabs(context)) {
        const id = this.ids.get(page) ?? (await this.tabId(context, page));
        if (id === null) continue;
        this.ids.set(page, id);
        listed.add(id);
      }
      const own = new Set(targetInfos.filter((t) => listed.has(t.targetId)).map((t) => t.browserContextId));
      return targetInfos
        .filter((t) => t.type === "page" && !t.subtype && own.has(t.browserContextId))
        .map((t) => t.targetId)
        .filter((id) => !listed.has(id) && !this.givenUp.has(id));
    } catch {
      return [];
    }
  }

  /**
   * Waits, up to NEW_TAB_WAIT_MS, for new tabs to be listed and to have their documents, so that they are offered
   * with their titles. A tab still unlisted then (no answer, a 204) is given up. True when there was one to wait for.
   */
  async awaitNewTabs(context: BrowserContext): Promise<boolean> {
    const deadline = performance.now() + NEW_TAB_WAIT_MS;
    let pending = await this.unlistedTabs(context);
    if (pending.length === 0) return false;
    const awaited = new Set<string>();
    while (pending.length > 0 && performance.now() < deadline) {
      for (const id of pending) awaited.add(id);
      await sleep(25);
      pending = await this.unlistedTabs(context);
    }
    for (const id of pending) this.givenUp.add(id);
    const arrived = this.openTabs(context).filter((page) => awaited.has(this.ids.get(page) ?? ""));
    const timeout = Math.max(1, deadline - performance.now()); // 0 would wait without a limit.
    await Promise.all(arrived.map((page) => page.waitForLoadState("domcontentloaded", { timeout }).catch(() => {})));
    return true;
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
