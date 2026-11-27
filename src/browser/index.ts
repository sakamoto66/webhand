/** Playwright launches an isolated Chrome or attaches to the session Chrome; observation and input go through one CDP session. */

import {
  type BrowserContext,
  type CDPSession,
  chromium,
  type Frame,
  type Browser as PlaywrightBrowser,
  type Page as PlaywrightPage,
} from "playwright-core";
import { sleep } from "../core/format.ts";
import { type Action, type Page, StalePage } from "../core/types.ts";
import type { Finding } from "../explore.ts";
import type { StorageState } from "../storage/auth.ts";
import { dispatchAction } from "./actions/index.ts";
import { connectLocal } from "./connect.ts";
import { DownloadTracker } from "./downloads.ts";
import { ExploreWatcher } from "./explore-watcher.ts";
import { FrameRegistry, frameOf } from "./frames.ts";
import { staleParts } from "./freshness.ts";
import { guardDocuments } from "./request-guard.ts";
import {
  COMPAT,
  CONTEXTS,
  LIST_END,
  PAGE_CHECK,
  ROWS,
  STATUS,
  settleScript,
  TAKE_WINDOWS,
  TRACK_WINDOWS,
  UNSEEN,
} from "./scripts/index.ts";
import { SentTracker } from "./sent.ts";
import { asset, READ_STATE, readState, type ViewChoice } from "./snapshot.ts";
import { readStorageState, restoreStorageState } from "./storage.ts";
import { TabManager } from "./tabs.ts";

export { asset, READ_STATE, type ViewChoice };

/** What a run log needs to tell a block from a page that did not load. */
export interface PageCheck {
  http_status: number | null; // The main document's status; null when the browser records none (about:blank).
  title: string;
  challenge: string[];
  text_chars: number; // Visible text length; near 0 is a blank or still-loading page.
}

export interface OpenOptions {
  headless?: boolean;
  /** Attach to the session Chrome on this port instead of launching a throwaway one. */
  port?: number | null;
  /** With port: close tabs that never loaded when they time the connection out, say how many, and connect once more. */
  onStuckTabsClosed?: (count: number) => void;
  /** Attach to a Chrome on another host (Browser Run) by its CDP URL, with the headers it asks for. Instead of port. */
  endpoint?: { url: string; headers: Record<string, string> } | null;
  /** Claude's choice of regions to focus on or skip when observing. */
  view?: ViewChoice | null;
  /** Keep the current tab in the session's tab file so later commands return to it. Off for a browser that is never re-attached. */
  rememberTab?: boolean;
  /** Note the pages that ask for a new window. For an engine that opens none (Lightpanda, Obscura), so the log shows it. */
  trackWindows?: boolean;
  /** Where Chrome saves files the page downloads. Absolute; made if missing. Local Chrome only. */
  downloadDir?: string | null;
  /** Exploring: refuse requests to hosts outside this list, and note what the pages report going wrong. Local Chrome only. */
  explore?: { allow: string[] } | null;
  /** Service boundary: refuse document navigations, redirects, and new tabs outside these hosts. */
  allowedDomains?: string[] | null;
  /** Fill in what the engine lacks (Obscura: iterable select.selectedOptions) so snapshot reads the page as in Chrome. */
  compat?: boolean;
}

export class Browser {
  view: ViewChoice | null;
  readonly attached: boolean;
  private keepsTab = true;
  private tracksWindows = false;
  private compat = false;
  private guarded: string[] | null = null;
  private readonly downloads: DownloadTracker;
  private readonly explorer = new ExploreWatcher();
  private readonly tabs = new TabManager();
  private readonly sending = new SentTracker();
  private readonly frameRegistry = new FrameRegistry();
  browser!: PlaywrightBrowser;
  context!: BrowserContext;
  page!: PlaywrightPage;
  cdp!: CDPSession;

  private constructor(attached: boolean, view: ViewChoice | null, downloadDir: string | null) {
    this.attached = attached;
    this.view = view;
    this.downloads = new DownloadTracker(downloadDir);
  }

  /** Launch a throwaway Chrome for url, or attach to the session Chrome on port. */
  static async open(url: string | null = null, options: OpenOptions = {}): Promise<Browser> {
    const port = options.port ?? null;
    const endpoint = options.endpoint ?? null;
    const instance = new Browser(port !== null || endpoint !== null, options.view ?? null, options.downloadDir ?? null);
    instance.keepsTab = options.rememberTab ?? true;
    instance.tracksWindows = options.trackWindows ?? false;
    instance.compat = options.compat ?? false;
    try {
      if (port !== null || endpoint !== null) {
        instance.browser = endpoint
          ? await chromium.connectOverCDP(endpoint.url, { headers: endpoint.headers })
          : await connectLocal(port as number, options.onStuckTabsClosed);
        instance.context = instance.browser.contexts()[0] ?? (await instance.browser.newContext());
        await instance.tabs.findPlaceholder(instance.context);
        if (!options.explore && options.allowedDomains?.length) {
          const allow = options.allowedDomains;
          await guardDocuments(await instance.browser.newBrowserCDPSession(), () => allow); // Before any page opens.
        }
        await instance.explorer.watch(
          instance.browser,
          instance.context,
          instance.tabs.openTabs(instance.context),
          options.explore ?? null,
        );
        if (url) {
          // A saved profile may restore old tabs. The run owns exactly one fresh tab.
          const stale = instance.tabs.openTabs(instance.context);
          instance.page = await instance.context.newPage();
          for (const page of stale) await page.close();
          await instance.page.goto(url, { waitUntil: "load" });
        } else {
          instance.page = await instance.tabs.rememberedTab(instance.context);
        }
        instance.cdp = await instance.context.newCDPSession(instance.page);
        instance.downloads.allow(instance.context);
        instance.sending.watch(instance.context);
        await instance.tabs.rememberTab(instance.context, instance.page, instance.attached, instance.keepsTab);
        return instance;
      }
      // launch() uses a throwaway profile. Never point this at a signed-in profile.
      instance.browser = await chromium.launch({ channel: "chrome", headless: options.headless ?? true });
      instance.context = await instance.browser.newContext({ viewport: { width: 1120, height: 780 } });
      instance.page = await instance.context.newPage();
      instance.cdp = await instance.context.newCDPSession(instance.page);
      instance.downloads.allow(instance.context);
      instance.sending.watch(instance.context);
      if (url) await instance.page.goto(url, { waitUntil: "load" });
      return instance;
    } catch (error) {
      await instance.close();
      throw error;
    }
  }

  /** allowed_domains on an engine without a browser-wide CDP session (Lightpanda): the page is guarded. A later call replaces the hosts. */
  async guardDocuments(allow: string[]): Promise<void> {
    const guarding = this.guarded !== null;
    this.guarded = allow;
    if (!guarding) await guardDocuments(this.cdp, () => this.guarded ?? []);
  }

  takeFindings(): Finding[] {
    return this.explorer.take();
  }

  takeDownloads(): { name: string; bytes: number }[] {
    return this.downloads.take();
  }

  storageState(): Promise<StorageState> {
    return readStorageState(this.context, this.tabs.openTabs(this.context));
  }

  restore(state: StorageState, url: string): Promise<string[]> {
    return restoreStorageState(this.context, this.page, (expr) => this.evaluate(expr), state, url);
  }

  get version(): string {
    return this.browser.version();
  }

  // biome-ignore lint/suspicious/noExplicitAny: CDP methods and results are untyped here.
  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    return this.cdp.send(method as any, params);
  }

  /** Read-only evaluation. A navigation in progress surfaces as StalePage. */
  // biome-ignore lint/suspicious/noExplicitAny: page values are untyped JSON.
  async evaluate(expression: string, options: { awaitPromise?: boolean } = {}): Promise<any> {
    let response: { exceptionDetails?: unknown; result?: { value?: unknown } };
    try {
      response = await this.call("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: options.awaitPromise ?? false,
      });
    } catch {
      throw new StalePage("Document changed during evaluation");
    }
    if (response.exceptionDetails) throw new StalePage("Document changed during evaluation");
    return response.result?.value ?? null;
  }

  /** The page's frames, the main one first. For tests. */
  frames(): Frame[] {
    return this.page.frames();
  }

  // biome-ignore lint/suspicious/noExplicitAny: page values are untyped JSON.
  private evaluateFor(node: unknown, expression: string): Promise<any> {
    return this.frameRegistry.evaluateFor(node, expression, (expr) => this.evaluate(expr));
  }

  async observe(): Promise<Page> {
    const left = await this.tabs.leaveClosedTab(this.context, this.page, this.attached, this.keepsTab);
    if (left) {
      this.page = left.page;
      this.cdp = left.cdp;
    }
    for (let i = 0; i < 10; i++) {
      let state: Page | null;
      try {
        await this.evaluate(settleScript(), { awaitPromise: true });
        // An engine whose windows are tracked opens no tabs. After a wait for one, this page is settled again.
        if (!this.tracksWindows && (await this.tabs.awaitNewTabs(this.context))) {
          await this.evaluate(settleScript(), { awaitPromise: true });
        }
        if (this.compat) await this.evaluate(COMPAT);
        if (this.tracksWindows) await this.evaluate(TRACK_WINDOWS);
        state = await this.evaluate(readState(this.view));
        if (state !== null && this.view?.whole) state.status = await this.evaluate(STATUS);
        if (state !== null) await this.frameRegistry.observe(this.page, state, this.view, this.compat);
        if (state !== null) await this.tabs.offerTabs(this.context, this.page, state);
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
        state = null;
      }
      if (state !== null) return state;
      await sleep(20);
    }
    throw new StalePage("Page did not settle");
  }

  async fresh(page: Page, action: Action | null = null): Promise<boolean> {
    return (await this.staleParts(page, action)).length === 0;
  }

  /** What differs from the observation: nothing when fresh. The parts are named for the run log only. */
  staleParts(page: Page, action: Action | null = null): Promise<string[]> {
    return staleParts(
      {
        evaluate: (expr) => this.evaluate(expr),
        evaluateFor: (node, expr) => this.evaluateFor(node, expr),
        whole: Boolean(this.view?.whole),
      },
      page,
      action,
    );
  }

  /** The text around observed elements, by node. Read-only. */
  async contexts(nodes: number[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const no of new Set(nodes.map(frameOf))) {
      const own = nodes.filter((n) => frameOf(n) === no);
      Object.assign(out, (await this.evaluateFor(own[0], `${CONTEXTS}(${JSON.stringify(own)})`)) ?? {});
    }
    return out;
  }

  /** Opens a page a scan has already visited, to come back to an item on it. Navigation only. */
  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "load" });
  }

  /** The text of each list or table item in view, top to bottom of the document. */
  async rows(): Promise<string[]> {
    return (await this.evaluate(ROWS)) ?? [];
  }

  /** The bottom of the main list's last item, in pixels from the top of the viewport; null without a list. */
  async listEnd(): Promise<number | null> {
    return (await this.evaluate(LIST_END)) ?? null;
  }

  /** Execute once. StalePage means nothing happened; MutationUncertain means do not retry. */
  async act(action: Action, page: Page, text: string | null = null): Promise<void> {
    const changed = await this.staleParts(page, action);
    if (changed.length) throw new StalePage("Page changed since this decision", changed);
    this.sending.reset();
    await dispatchAction(
      {
        page: this.page,
        frames: this.frameRegistry,
        downloads: this.downloads,
        evaluate: (expr) => this.evaluate(expr),
        evaluateFor: (node, expr) => this.evaluateFor(node, expr),
        call: (method, params) => this.call(method, params),
        switchTab: async (tabAction, tabPage) => {
          const switched = await this.tabs.switchTab(
            this.context,
            this.page,
            this.cdp,
            tabAction,
            tabPage,
            this.attached,
            this.keepsTab,
          );
          this.page = switched.page;
          this.cdp = switched.cdp;
        },
      },
      action,
      page,
      text,
    );
  }

  /** Whether a request other than a read left the pages since the last act began. */
  async sentRequest(): Promise<boolean> {
    return this.sending.any;
  }

  /** Read-only signs of why a page cannot be used: see PageCheck. */
  async check(): Promise<PageCheck> {
    return await this.evaluate(PAGE_CHECK);
  }

  /** Frames, canvases, and plugin objects in the page: parts whose content webhand does not observe. */
  async unseen(): Promise<Record<string, number>> {
    return (await this.evaluate(UNSEEN)) ?? {};
  }

  /** The new windows pages asked for since the last call (URLs). Only when trackWindows is on. */
  async ignoredWindows(): Promise<string[]> {
    return this.tracksWindows ? ((await this.evaluate(TAKE_WINDOWS)) ?? []) : [];
  }

  /** A PNG of the viewport. Read-only; typed values show in it. */
  async screenshot(): Promise<Buffer> {
    const response = await this.call("Page.captureScreenshot", { format: "png" });
    return Buffer.from(response.data, "base64");
  }

  /**
   * An attached session Chrome stays alive; only session.stopChrome() ends it. Closing a browser that
   * connectOverCDP attached to only disconnects: Chrome keeps its tabs and pages.
   */
  async close(): Promise<void> {
    if (!this.browser) return;
    if (this.attached) await this.cdp?.detach().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}
