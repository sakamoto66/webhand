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
  read?: string[];
}

/** The snapshot expression for a view ({focus, skip} region patterns). The view never changes freshness. */
function readState(view: ViewChoice | null = null): string {
  return `(${SNAPSHOT})(${JSON.stringify(view ?? {})})`;
}

export const READ_STATE = readState();

/**
 * Signs of a bot check, for the run log. A marker is a sign, not proof: a normal page can embed a CAPTCHA
 * widget. Only element presence is read, never text or field values.
 */
const CHALLENGES: [string, string][] = [
  [
    "cloudflare",
    'iframe[src*="challenges.cloudflare.com"], script[src*="challenges.cloudflare.com"], #challenge-form, .cf-turnstile',
  ],
  ["recaptcha", 'iframe[src*="recaptcha"], .g-recaptcha'],
  ["hcaptcha", 'iframe[src*="hcaptcha.com"], .h-captcha'],
  ["datadome", '[src*="captcha-delivery.com"]'],
  ["perimeterx", "#px-captcha"],
  ["arkose", 'iframe[src*="arkoselabs.com"], iframe[src*="funcaptcha"]'],
];

/** What a run log needs to tell a block from a page that did not load. */
export interface PageCheck {
  http_status: number | null; // The main document's status; null when the browser records none (about:blank).
  title: string;
  challenge: string[];
  text_chars: number; // Visible text length; near 0 is a blank or still-loading page.
}

const PAGE_CHECK = `(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const found = ${JSON.stringify(CHALLENGES)}.filter(([, selector]) => document.querySelector(selector)).map(([name]) => name);
  return {
    http_status: nav && nav.responseStatus ? nav.responseStatus : null,
    title: document.title.slice(0, 120),
    challenge: found,
    text_chars: document.body ? document.body.innerText.length : 0,
  };
})()`;
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
// Scrolls an observed element into the middle of the viewport. It never clicks or types.
const REVEAL = `(node => {
  const e=window.__browserLab?.nodes.get(node);
  if (!e?.isConnected) return false;
  e.scrollIntoView({block: "center", inline: "nearest", behavior: "instant"});
  return true;
})`;

// The text of the row, card, or list item each observed element is in, for comparing items. Page text only;
// field values are not part of innerText.
const CONTEXTS = `(nodes => {
  const c=window.__browserLab, out={};
  for (const node of nodes) {
    const e=c?.nodes.get(node);
    if (!e?.isConnected) continue;
    const item=e.closest('tr,li,[role="row"],[role="listitem"],article,[role="article"]') || e.parentElement;
    out[node]=String(item?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
  }
  return out;
})`;

// The items of lists and tables in view, header rows left out. An item is a table row, or one of three or more
// sibling blocks of the same tag and class (cards built from divs, list items, articles), outside navigation,
// headers and footers. Of nested items the outer one is kept (a card, not the bullet points inside it), unless
// it only wraps the inner ones: they hold nearly all of its text (a row of cards in a grid), or it is too long
// for one item (a section holding a whole list).
const ROWS = `(() => {
  const ROW='tr,[role="row"]', BLOCK=new Set(['DIV','LI','ARTICLE','SECTION','A','DD']);
  const SKIP='nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="dialog"]';
  const items=new Set(document.querySelectorAll(ROW));
  for (const parent of document.querySelectorAll('body *')) {
    if (parent.childElementCount<3) continue;
    const groups=new Map();
    for (const child of parent.children) {
      if (!BLOCK.has(child.tagName) && !child.matches('[role="listitem"],[role="article"]')) continue;
      const key=child.tagName+'|'+child.getAttribute('class')+'|'+child.getAttribute('role');
      groups.set(key, [...(groups.get(key) || []), child]);
    }
    for (const group of groups.values()) {
      if (group.length<3) continue;
      for (const e of group) if ((e.textContent || '').trim()) items.add(e);
    }
  }
  const length=e=>(e.textContent || '').replace(/\\s+/g, '').length;
  const up=new Map(), kids=new Map();
  for (const e of items) {
    let a=e.parentElement;
    while (a && !items.has(a)) a=a.parentElement;
    up.set(e, a);
    if (a) kids.set(a, [...(kids.get(a) || []), e]);
  }
  const wrapper=e=>{
    const inner=kids.get(e) || [];
    return inner.length>=2 && (length(e)>1500 || inner.reduce((n,d)=>n+length(d),0)>=0.85*length(e));
  };
  const kept=e=>{
    if (e.closest(SKIP) || wrapper(e)) return false;
    for (let a=up.get(e); a; a=up.get(a)) if (!a.closest(SKIP) && !wrapper(a)) return false;
    return true;
  };
  const out=[];
  for (const e of [...items].sort((a,b)=>a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1)) {
    const r=e.getBoundingClientRect();
    if (r.height<=0 || r.width<=0 || r.bottom<=0 || r.top>=innerHeight) continue;
    if (e.querySelector('th,[role="columnheader"]') && !e.querySelector('td,[role="cell"],[role="gridcell"]')) continue;
    if (!kept(e)) continue;
    const text=String(e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
    if (text) out.push(text);
  }
  return out;
})()`;

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
    if (action !== null && ["click", "select", "reveal"].includes(action.kind)) {
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

  /** The text around observed elements, by node. Read-only. */
  async contexts(nodes: number[]): Promise<Record<string, string>> {
    return (await this.evaluate(`${CONTEXTS}(${JSON.stringify(nodes)})`)) ?? {};
  }

  /** Opens a page a scan has already visited, to come back to an item on it. Navigation only. */
  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "load" });
  }

  /** The text of each list or table item in view, top to bottom of the document. */
  async rows(): Promise<string[]> {
    return (await this.evaluate(ROWS)) ?? [];
  }

  /** Execute once. StalePage means nothing happened; MutationUncertain means do not retry. */
  async act(action: Action, page: Page, text: string | null = null): Promise<void> {
    if (!(await this.fresh(page, action))) throw new StalePage("Page changed since this decision");
    const kind = action.kind;
    if (kind === "wait") {
      await sleep(100);
      return;
    }
    if (kind === "reveal") {
      const found = await this.evaluate(`${REVEAL}(${JSON.stringify(action.node)})`);
      if (!found) throw new StalePage("Target changed");
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

  /** Read-only signs of why a page cannot be used: see PageCheck. */
  async check(): Promise<PageCheck> {
    return await this.evaluate(PAGE_CHECK);
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
