/** Playwright launches an isolated Chrome or attaches to the session Chrome; observation and input go through one CDP session. */

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  type BrowserContext,
  type CDPSession,
  chromium,
  type Browser as PlaywrightBrowser,
  type Page as PlaywrightPage,
} from "playwright-core";
import { sleep } from "./format.ts";
import { type Action, MutationUncertain, type Page, StalePage } from "./types.ts";

export function asset(name: string): string {
  return readFileSync(new URL(`../assets/${name}`, import.meta.url), "utf8");
}

const SNAPSHOT = asset("snapshot.js").trim();

export interface ViewChoice {
  focus?: string[];
  skip?: string[];
}

/** The snapshot expression for a view ({focus, skip} region patterns). The view never changes freshness. */
function readState(view: ViewChoice | null = null): string {
  return `(${SNAPSHOT})(${JSON.stringify(view ?? {})})`;
}

export const READ_STATE = readState();
const MARKER = `(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`;
// Read only once the document has loaded and the DOM has stopped changing, so content rendered by
// DOMContentLoaded handlers or after an XHR is observed. A page that never goes quiet is read at the cap.
const SETTLE_QUIET_MS = 150;
export const SETTLE_CAP_MS = 2000;
const SETTLE = `new Promise(resolve => {
  const start = performance.now();
  let last = start;
  const observer = new MutationObserver(() => { last = performance.now(); });
  observer.observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
  const check = () => {
    const now = performance.now();
    if (now - start >= ${SETTLE_CAP_MS} ||
        (document.readyState === 'complete' && now - last >= ${SETTLE_QUIET_MS})) {
      observer.disconnect();
      resolve();
    } else setTimeout(check, 25);
  };
  check();
})`;
// Node ids are code-owned references to observed elements, never model output.
const RESOLVE_TARGET = `(action => {
  const c=window.__browserLab, e=c?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || c.closest(e,'[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  // The center of the whole box first. An inline element that wraps can leave that center between its lines,
  // so the center of each line box is tried next.
  for (const r of [e.getBoundingClientRect(), ...e.getClientRects()]) {
    const x=r.x+r.width/2, y=r.y+r.height/2;
    if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (c.hit(e,x,y)) return {x,y};
  }
  return null;
})`;
const SELECT_OPTION = `(action => {
  const e=window.__browserLab.nodes.get(action.node);
  if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
      !o.disabled && !o.closest('optgroup[disabled]'))) return false;
  e.value=action.value;
  e.dispatchEvent(new Event('input',{bubbles:true}));
  e.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
})`;

export interface OpenOptions {
  headless?: boolean;
  /** Attach to the session Chrome on this port instead of launching a throwaway one. */
  port?: number | null;
  /** Claude's choice of regions to focus on or skip when observing. */
  view?: ViewChoice | null;
}

export class Browser {
  view: ViewChoice | null;
  readonly attached: boolean;
  browser!: PlaywrightBrowser;
  context!: BrowserContext;
  page!: PlaywrightPage;
  cdp!: CDPSession;

  private constructor(attached: boolean, view: ViewChoice | null) {
    this.attached = attached;
    this.view = view;
  }

  /** Launch a throwaway Chrome for url, or attach to the session Chrome on port. */
  static async open(url: string | null = null, options: OpenOptions = {}): Promise<Browser> {
    const port = options.port ?? null;
    const instance = new Browser(port !== null, options.view ?? null);
    try {
      if (port !== null) {
        instance.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        instance.context = instance.browser.contexts()[0];
        if (url) {
          // A saved profile may restore old tabs. The run owns exactly one fresh tab.
          const stale = [...instance.context.pages()];
          instance.page = await instance.context.newPage();
          for (const page of stale) await page.close();
          await instance.page.goto(url, { waitUntil: "load" });
        } else {
          instance.page = instance.context.pages()[0];
        }
        instance.cdp = await instance.context.newCDPSession(instance.page);
        return instance;
      }
      // launch() uses a throwaway profile. Never point this at a signed-in profile.
      instance.browser = await chromium.launch({ channel: "chrome", headless: options.headless ?? true });
      instance.context = await instance.browser.newContext({ viewport: { width: 1120, height: 780 } });
      instance.page = await instance.context.newPage();
      instance.cdp = await instance.context.newCDPSession(instance.page);
      if (url) await instance.page.goto(url, { waitUntil: "load" });
      return instance;
    } catch (error) {
      await instance.close();
      throw error;
    }
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

  async observe(): Promise<Page> {
    for (let i = 0; i < 10; i++) {
      let state: Page | null;
      try {
        await this.evaluate(SETTLE, { awaitPromise: true });
        state = await this.evaluate(readState(this.view));
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
    if (action !== null && (action.kind === "click" || action.kind === "select")) {
      const node = action.node;
      if (!Number.isInteger(node)) return false;
      const current = await this.evaluate(
        "(() => { const c=window.__browserLab; " +
          `return c ? [c.pageKey(),c.guard(c.nodes.get(${node}))] : null; })()`,
      );
      return isDeepStrictEqual(current, [page.page_key, page.guards?.[String(node)] ?? null]);
    }
    return isDeepStrictEqual(await this.evaluate(MARKER), page.marker);
  }

  /** Execute once. StalePage means nothing happened; MutationUncertain means do not retry. */
  async act(action: Action, page: Page, text: string | null = null): Promise<void> {
    if (!(await this.fresh(page, action))) throw new StalePage("Page changed since this decision");
    const kind = action.kind;
    if (kind === "wait") {
      await sleep(100);
      return;
    }
    let target: { x: number; y: number } | null = null;
    if (kind !== "scroll") {
      target = await this.evaluate(`${RESOLVE_TARGET}(${JSON.stringify(action)})`);
      if (target === null) throw new StalePage("Target changed or is covered");
    }
    try {
      if (kind === "scroll") {
        await this.call("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 550,
          y: 650,
          deltaX: 0,
          deltaY: action.delta,
        });
      } else if (kind === "select") {
        await this.select(action);
      } else {
        const { x, y } = target as { x: number; y: number };
        await this.click(x, y);
        if (kind === "fill") await this.replaceText(text);
      }
    } catch (error) {
      if (error instanceof MutationUncertain) throw error;
      throw new MutationUncertain(`${kind} was interrupted`);
    }
  }

  private async click(x: number, y: number): Promise<void> {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  }

  private async select(action: Action): Promise<void> {
    const response = await this.call("Runtime.evaluate", {
      expression: `${SELECT_OPTION}(${JSON.stringify(action)})`,
      returnByValue: true,
    });
    if (response?.result?.value !== true) throw new MutationUncertain("Dropdown change was not confirmed");
  }

  private async replaceText(text: string | null): Promise<void> {
    if (text === null) throw new MutationUncertain("Field was focused without text");
    const modifiers = process.platform === "darwin" ? 4 : 2;
    const key = { key: "a", code: "KeyA", modifiers };
    await this.call("Input.dispatchKeyEvent", { type: "keyDown", commands: ["selectAll"], ...key });
    await this.call("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    await this.call("Input.insertText", { text });
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
