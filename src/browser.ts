/** Playwright launches an isolated Chrome or attaches to the session Chrome; observation and input go through one CDP session. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type BrowserContext,
  type CDPSession,
  chromium,
  type Browser as PlaywrightBrowser,
  type Page as PlaywrightPage,
} from "playwright-core";
import { sleep } from "./format.ts";
import { home as sessionHome } from "./session.ts";
import { type Action, MutationUncertain, type Page, StalePage } from "./types.ts";

export function asset(name: string): string {
  return readFileSync(new URL(`../assets/${name}`, import.meta.url), "utf8");
}

const SNAPSHOT = asset("snapshot.js").trim();

export interface ViewChoice {
  focus?: string[];
  skip?: string[];
  read?: string[];
  /** v2: offer elements beyond the viewport with their own operations. */
  whole?: boolean;
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
// v2: the kind of page, from signs only (element presence and the document's HTTP status, never text or values).
const STATUS = `(() => {
  const shown = e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(e).visibility !== 'hidden'; };
  const any = selector => [...document.querySelectorAll(selector)].some(shown);
  const nav = performance.getEntriesByType('navigation')[0];
  const http = nav && nav.responseStatus ? nav.responseStatus : null;
  const signs = ${JSON.stringify(CHALLENGES)}.filter(([, selector]) => document.querySelector(selector)).map(([name]) => name);
  const kind = http >= 400 ? 'error' : signs.length ? 'check' : any('input[type="password"]') ? 'sign_in'
    : any('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]') ? 'dialog' : 'ready';
  const count = selector => [...document.querySelectorAll(selector)].filter(shown).length;
  const unseen = {frames: count('iframe,frame'), canvases: count('canvas'), objects: count('object,embed')};
  return {kind, ...(http ? {http_status: http} : {}), ...(signs.length ? {signs} : {}), unseen};
})()`;
const UNSEEN = `(() => {
  const shown = e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0; };
  const count = selector => [...document.querySelectorAll(selector)].filter(shown).length;
  return {frames: count('iframe,frame'), canvases: count('canvas'), objects: count('object,embed')};
})()`;
const MARKER = `(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`;

// The parts of the freshness keys in assets/snapshot.js (viewportKey, pageKey, guard, marker), by position.
const VIEWPORT_PARTS = ["navigation", "url", "scroll", "scroll", "viewport", "viewport"];
const PAGE_KEY_PARTS = [...VIEWPORT_PARTS, "form_fields"];
const GUARD_PARTS = [
  "target_replaced",
  "target_label",
  "target_label",
  ...Array(9).fill("target_state"),
  "target_link",
  "scope_text",
  "scope_kind",
];
// v2: what the freshness check leaves out. The target is hit-tested just before input whatever the scroll, and
// the text around a target outside a list item (a form, a dialog) can change without changing what it does.
// Without a target (Jev's DONE or BLOCKED), the page's own text is left out too: a ticking timer or a rotating
// banner would otherwise keep any answer from standing. The address, the elements, and field values still count.
const V2_IGNORED = new Set(["scroll", "viewport"]);
const V2_IGNORED_PAGE = new Set(["scroll", "viewport", "title", "text"]);
const UNCHANGING = new Set(["scroll", "wait"]);
const MARKER_PARTS = [...VIEWPORT_PARTS, "title", "text", "semantics", "form_fields"];

/** The names of the parts that differ between two freshness keys, each name once, in order. */
function differing(current: unknown, observed: unknown, parts: string[]): string[] {
  if (isDeepStrictEqual(current, observed)) return [];
  if (!Array.isArray(current) || !Array.isArray(observed) || current.length !== observed.length) return ["shape"];
  const names = current.flatMap((value, i) => (isDeepStrictEqual(value, observed[i]) ? [] : [parts[i] ?? "other"]));
  return [...new Set(names)];
}
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
// Where to click an observed element, or why not: gone, disabled, hidden, read-only, outside the viewport, or
// covered (with what covers it).
const RESOLVE_TARGET = `(action => {
  const c=window.__browserLab, e=c?.nodes.get(action.node);
  if (!e?.isConnected) return {reason:'gone'};
  if (e.matches(':disabled') || c.closest(e,'[aria-disabled="true"],[inert]')) return {reason:'disabled'};
  if (!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return {reason:'hidden'};
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return {reason:'read_only'};
  // The center of the whole box first. An inline element that wraps can leave that center between its lines,
  // so the center of each line box is tried next.
  let covered=null;
  for (const r of [e.getBoundingClientRect(), ...e.getClientRects()]) {
    const x=r.x+r.width/2, y=r.y+r.height/2;
    if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (c.hit(e,x,y)) return {x,y};
    covered ??= c.cover(x,y);
  }
  return covered ? {reason:'covered', cover:covered} : {reason:'outside'};
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

// The items of lists and tables, header rows left out, in document order. An item is a table row, or one of three or more
// sibling blocks of the same tag and class (cards built from divs, list items, articles), outside navigation,
// headers and footers. Of nested items the outer one is kept (a card, not the bullet points inside it), unless
// it only wraps the inner ones: they hold nearly all of its text (a row of cards in a grid), or it is too long
// for one item (a section holding a whole list).
const ITEMS = `(() => {
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
  const header=e=>e.querySelector('th,[role="columnheader"]') && !e.querySelector('td,[role="cell"],[role="gridcell"]');
  return [...items].filter(e=>!header(e) && kept(e))
    .sort((a,b)=>a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);
})`;

const ROWS = `(() => {
  const out=[];
  for (const e of ${ITEMS}()) {
    const r=e.getBoundingClientRect();
    if (r.height<=0 || r.width<=0 || r.bottom<=0 || r.top>=innerHeight) continue;
    const text=String(e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
    if (text) out.push(text);
  }
  return out;
})()`;

// Where the main list ends: the bottom, in the viewport, of the last item of the longest list (items of the same
// tag and class under parents of the same tag and class, so a grid's rows count as one list). Null without a list
// of three or more items.
const LIST_END = `(() => {
  const sig=e=>e.tagName+'|'+e.getAttribute('class');
  const lists=new Map();
  for (const e of ${ITEMS}()) {
    if (!(e.getBoundingClientRect().height>0)) continue;
    const key=sig(e)+'<'+(e.parentElement ? sig(e.parentElement) : '');
    lists.set(key, [...(lists.get(key) || []), e]);
  }
  let longest=[];
  for (const list of lists.values()) if (list.length>longest.length) longest=list;
  return longest.length>=3 ? Math.round(longest.at(-1).getBoundingClientRect().bottom) : null;
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

const MAX_TAB_TITLE = 60;

/** A tab's title as the model sees it: one line, clipped. Page text, so never instructions. */
function tabTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, MAX_TAB_TITLE);
}

/** Which tab the run is on, kept for the next command: each command attaches to the session Chrome anew. */
function tabFile(): string {
  return join(sessionHome(), "tab");
}

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
          instance.page = await instance.rememberedTab();
        }
        instance.cdp = await instance.context.newCDPSession(instance.page);
        await instance.rememberTab();
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

  private openTabs(): PlaywrightPage[] {
    return this.context.pages().filter((page) => !page.isClosed());
  }

  private async tabId(page: PlaywrightPage): Promise<string | null> {
    try {
      const session = await this.context.newCDPSession(page);
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
  private async rememberedTab(): Promise<PlaywrightPage> {
    const pages = this.openTabs();
    const file = tabFile();
    if (pages.length > 1 && existsSync(file)) {
      const wanted = readFileSync(file, "utf8").trim();
      for (const page of pages) if ((await this.tabId(page)) === wanted) return page;
    }
    return pages[0];
  }

  private async rememberTab(): Promise<void> {
    if (!this.attached) return;
    const id = await this.tabId(this.page);
    if (id === null) return;
    mkdirSync(sessionHome(), { recursive: true });
    writeFileSync(tabFile(), id, { encoding: "utf8", mode: 0o600 });
  }

  /** The other tabs, as controls Jev can choose by number. Offered only when more than one tab is open. */
  private async offerTabs(state: Page): Promise<void> {
    const open = this.openTabs();
    if (open.length < 2) return;
    const current = open.indexOf(this.page);
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
  private async switchTab(action: Action, page: Page): Promise<void> {
    const open = this.openTabs();
    const tabs = page.tabs;
    if (!tabs || open.length !== tabs.count || open[tabs.current - 1] !== this.page) {
      throw new StalePage("Tabs changed since this decision", ["tabs"]);
    }
    const target = open[action.tab - 1];
    if (!target || target === this.page) throw new StalePage("Tab is gone", ["tab_gone"]);
    const title = tabTitle(await target.title().catch(() => ""));
    if (title !== action.title) throw new StalePage("Tab changed since this decision", ["tab_title"]);
    try {
      const next = await this.context.newCDPSession(target);
      await target.bringToFront();
      await this.cdp?.detach().catch(() => {});
      this.page = target;
      this.cdp = next;
    } catch {
      throw new StalePage("Tab could not be switched to", ["tab_gone"]);
    }
    await this.rememberTab();
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

  /** A tab that closed itself (a popup done with its work) leaves the run on the last tab still open. */
  private async leaveClosedTab(): Promise<void> {
    if (!this.page.isClosed()) return;
    const open = this.openTabs();
    if (open.length === 0) throw new StalePage("Every tab is closed");
    this.page = open[open.length - 1];
    this.cdp = await this.context.newCDPSession(this.page);
    await this.rememberTab();
  }

  async observe(): Promise<Page> {
    await this.leaveClosedTab();
    for (let i = 0; i < 10; i++) {
      let state: Page | null;
      try {
        await this.evaluate(SETTLE, { awaitPromise: true });
        state = await this.evaluate(readState(this.view));
        // v2: what kind of page this is, for Jev and Claude.
        if (state !== null && this.view?.whole) state.status = await this.evaluate(STATUS);
        if (state !== null) await this.offerTabs(state);
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
  async staleParts(page: Page, action: Action | null = null): Promise<string[]> {
    // A compare or collect scan's own scroll: no decision to be stale (round gv1: 8 scans ended on "Page changed").
    if (action?.scan) return [];
    const parts = await this.differingParts(page, action);
    if (!this.view?.whole) return parts;
    // Scrolling and waiting change nothing on the page, and waiting is for the page to change: v2 never refuses
    // them (in BU Bench round gv2, 22 of 41 refusals were these, on pages whose text kept changing).
    if (action !== null && UNCHANGING.has(action.kind)) return [];
    if (action === null) return parts.filter((part) => !V2_IGNORED_PAGE.has(part));
    const item = page.guards?.[String(action.node)]?.[14] === "item";
    return parts.filter((part) => !V2_IGNORED.has(part) && (item || part !== "scope_text"));
  }

  private async differingParts(page: Page, action: Action | null): Promise<string[]> {
    // v2 checks typing against its field too, instead of against the whole viewport's text.
    const targeted = ["click", "select", "reveal", ...(this.view?.whole ? ["fill"] : [])];
    if (action !== null && targeted.includes(action.kind)) {
      const node = action.node;
      if (!Number.isInteger(node)) return ["target_unknown"];
      const current = await this.evaluate(
        "(() => { const c=window.__browserLab; " +
          `return c ? [c.pageKey(),c.guard(c.nodes.get(${node}))] : null; })()`,
      );
      if (current === null) return ["snapshot_gone"];
      const guard = page.guards?.[String(node)] ?? null;
      return [
        ...differing(current[0], page.page_key, PAGE_KEY_PARTS),
        ...(current[1] === null && guard !== null ? ["target_gone"] : differing(current[1], guard, GUARD_PARTS)),
      ];
    }
    const marker = await this.evaluate(MARKER);
    return marker === null && page.marker != null ? ["snapshot_gone"] : differing(marker, page.marker, MARKER_PARTS);
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

  /** The bottom of the main list's last item, in pixels from the top of the viewport; null without a list. */
  async listEnd(): Promise<number | null> {
    return (await this.evaluate(LIST_END)) ?? null;
  }

  /**
   * Where to click the action's element. When it is covered or outside the viewport, it is scrolled to the
   * middle once and tried again: a sticky header or a fixed bar often covers an element near an edge. Otherwise
   * StalePage, saying what covers it, so Jev can deal with that first. Nothing is clicked or typed here.
   */
  private async target(action: Action): Promise<{ x: number; y: number }> {
    const resolve = async () =>
      (await this.evaluate(`${RESOLVE_TARGET}(${JSON.stringify(action)})`)) as
        | { x: number; y: number }
        | { reason: string; cover?: string };
    let found = await resolve();
    if ("reason" in found && (found.reason === "covered" || found.reason === "outside")) {
      await this.evaluate(`${REVEAL}(${JSON.stringify(action.node)})`);
      await sleep(100);
      found = await resolve();
    }
    if (!("reason" in found)) return found;
    if (found.reason === "covered") {
      throw new StalePage(`Target is covered by ${found.cover}; deal with that first`, ["target_covered"]);
    }
    throw new StalePage(`Target is ${found.reason.replace("_", "-")}`, [`target_${found.reason}`]);
  }

  /** Execute once. StalePage means nothing happened; MutationUncertain means do not retry. */
  async act(action: Action, page: Page, text: string | null = null): Promise<void> {
    const changed = await this.staleParts(page, action);
    if (changed.length) throw new StalePage("Page changed since this decision", changed);
    const kind = action.kind;
    if (kind === "wait") {
      await sleep(100);
      return;
    }
    if (kind === "tab") return await this.switchTab(action, page);
    if (kind === "reveal") {
      const found = await this.evaluate(`${REVEAL}(${JSON.stringify(action.node)})`);
      if (!found) throw new StalePage("Target changed", ["target_gone"]);
      return;
    }
    let target: { x: number; y: number } | null = null;
    if (kind !== "scroll") target = await this.target(action);
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

  /** Frames, canvases, and plugin objects in the page: parts whose content webhand does not observe. */
  async unseen(): Promise<Record<string, number>> {
    return (await this.evaluate(UNSEEN)) ?? {};
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
