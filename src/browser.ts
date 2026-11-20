/** Playwright launches an isolated Chrome or attaches to the session Chrome; observation and input go through one CDP session. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  type BrowserContext,
  type CDPSession,
  chromium,
  type Frame,
  type Browser as PlaywrightBrowser,
  type Page as PlaywrightPage,
} from "playwright-core";
import type { StorageState } from "./auth.ts";
import { sleep } from "./format.ts";
import { home as sessionHome, tabPath } from "./session.ts";
import { type Action, MutationUncertain, type Page, StalePage } from "./types.ts";

export function asset(name: string): string {
  return readFileSync(new URL(`../assets/${name}`, import.meta.url), "utf8");
}

// A frame smaller than this on either side (a tracking pixel, an ad slot) is neither read nor counted as unseen.
const MIN_FRAME_SIDE = 20;
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
  const framed = [...document.querySelectorAll('iframe,frame')].filter(e => { const r=e.getBoundingClientRect(); return r.width>=${MIN_FRAME_SIDE} && r.height>=${MIN_FRAME_SIDE} && getComputedStyle(e).visibility !== 'hidden'; }).length;
  const unseen = {frames: framed, canvases: count('canvas'), objects: count('object,embed')};
  return {kind, ...(http ? {http_status: http} : {}), ...(signs.length ? {signs} : {}), unseen};
})()`;
const UNSEEN = `(() => {
  const shown = e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0; };
  const count = selector => [...document.querySelectorAll(selector)].filter(shown).length;
  const framed = [...document.querySelectorAll('iframe,frame')].filter(e => { const r=e.getBoundingClientRect(); return r.width>=${MIN_FRAME_SIDE} && r.height>=${MIN_FRAME_SIDE}; }).length;
  return {frames: framed, canvases: count('canvas'), objects: count('object,embed')};
})()`;
/**
 * Notes what asks for a new window: window.open and a click on a link with target=_blank. Nothing is stopped or
 * changed; the browser does what it does. Installed once per document, and read with TAKE_WINDOWS.
 */
const TRACK_WINDOWS = `(() => {
  if (window.__webhandWindows) return;
  const asked = [];
  window.__webhandWindows = asked;
  const open = window.open;
  window.open = function (url, ...rest) {
    let where = String(url ?? '');
    try { where = new URL(where, document.baseURI).href; } catch (e) {}
    asked.push(where);
    return open.call(this, url, ...rest);
  };
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[target],area[target]') : null;
    if (link && link.target === '_blank') asked.push(link.href);
  }, true);
})()`;
/**
 * What Obscura lacks that snapshot.js reads or a page's own script uses. Added to the page, so snapshot.js stays the
 * same for every engine. Installed once per document.
 *  - select.selectedOptions that can be spread (snapshot.js)
 *  - isContentEditable (snapshot.js: an editable div is a textbox)
 *  - a form's controls by name: form.guest, and a form by id: document.forms.id (page scripts; without it a handler that reads
 *    form.guest.value throws and the form is never submitted)
 * Not covered: a cursor set by a stylesheet rule reads as 'auto' (only an inline style gives 'pointer'), so an element
 * that is clickable only through a CSS cursor is not offered.
 */
const COMPAT = `(() => {
  if (window.__webhandCompat) return;
  window.__webhandCompat = true;
  const define = (proto, name, descriptor) => {
    try { if (!(name in proto)) Object.defineProperty(proto, name, { configurable: true, ...descriptor }); } catch (e) {}
  };
  try {
    Object.defineProperty(HTMLSelectElement.prototype, 'selectedOptions', {
      configurable: true,
      get() { return [...this.options].filter(option => option.selected); },
    });
  } catch (e) {}
  define(HTMLElement.prototype, 'isContentEditable', {
    get() {
      for (let node = this; node instanceof Element; node = node.parentElement) {
        const value = node.getAttribute('contenteditable');
        if (value !== null) return value !== 'false';
      }
      return false;
    },
  });
  // A name that is not a property is looked up among the controls (or, for a collection, its named items).
  const named = (proto, lookup) => {
    try {
      const parent = Object.getPrototypeOf(proto);
      Object.setPrototypeOf(proto, new Proxy(parent, {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && !(prop in target)) {
            try { const hit = lookup(receiver, prop); if (hit) return hit; } catch (e) {}
          }
          return Reflect.get(target, prop, receiver);
        },
      }));
    } catch (e) {}
  };
  {
    named(HTMLFormElement.prototype, (form, name) => form.elements && form.elements[name]);
    // document.forms is a NodeList here, which has no named items: wrap it so document.forms.id finds the form.
    const forms = Object.getOwnPropertyDescriptor(Document.prototype, 'forms');
    if (forms && forms.get) {
      Object.defineProperty(Document.prototype, 'forms', {
        configurable: true,
        get() {
          const list = forms.get.call(this);
          return new Proxy(list, {
            get(target, prop) {
              if (typeof prop === 'string' && !(prop in target)) {
                for (const form of target) if (form.id === prop || form.name === prop) return form;
              }
              const value = Reflect.get(target, prop, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      });
    }
  }
})()`;
const TAKE_WINDOWS = "(() => (window.__webhandWindows ?? []).splice(0))()";
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
/** Tests of the fixtures shorten the quiet time (WEBHAND_SETTLE_QUIET_MS) to run faster; people never set it. */
const settleQuietMs = () => Number(process.env.WEBHAND_SETTLE_QUIET_MS) || SETTLE_QUIET_MS;
export const SETTLE_CAP_MS = 2000;
const settleScript = () => `new Promise(resolve => {
  const start = performance.now();
  let last = start;
  const observer = new MutationObserver(() => { last = performance.now(); });
  observer.observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
  const check = () => {
    const now = performance.now();
    if (now - start >= ${SETTLE_CAP_MS} ||
        (document.readyState === 'complete' && now - last >= ${settleQuietMs()})) {
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

// v2: elements inside frames are read where they are, one snapshot per visible frame. A node id carries its
// frame: frame number times FRAME_BASE plus the id the frame's own snapshot gave. The main page is frame 0.
const FRAME_BASE = 1_000_000;
const MAX_FRAMES = 8;
const FRAME_TEXT_LIMIT = 1500;
const frameOf = (node: unknown): number => (Number.isInteger(node) ? Math.floor((node as number) / FRAME_BASE) : 0);
// Makes the ids a frame's snapshot gives start at its own base.
const seedFrame = (no: number) =>
  `(() => { const c = (window.__browserLab ||= {ids: new WeakMap(), nodes: new Map(), next: 1}); ` +
  `if (c.next < ${no * FRAME_BASE}) c.next = ${no * FRAME_BASE}; })()`;

/** A tab's title as the model sees it: one line, clipped. Page text, so never instructions. */
function tabTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, MAX_TAB_TITLE);
}

export interface OpenOptions {
  headless?: boolean;
  /** Attach to the session Chrome on this port instead of launching a throwaway one. */
  port?: number | null;
  /** Attach to a Chrome on another host (Browser Run) by its CDP URL, with the headers it asks for. Instead of port. */
  endpoint?: { url: string; headers: Record<string, string> } | null;
  /** Claude's choice of regions to focus on or skip when observing. */
  view?: ViewChoice | null;
  /** Keep the current tab in the session's tab file so later commands return to it. Off for a browser that is never re-attached. */
  rememberTab?: boolean;
  /** Note the pages that ask for a new window. For an engine that opens none (Lightpanda, Obscura), so the log shows it. */
  trackWindows?: boolean;
  /** Fill in what the engine lacks (Obscura: iterable select.selectedOptions) so snapshot.js reads the page as in Chrome. */
  compat?: boolean;
}

export class Browser {
  view: ViewChoice | null;
  readonly attached: boolean;
  private keepsTab = true;
  private tracksWindows = false;
  private compat = false;
  browser!: PlaywrightBrowser;
  context!: BrowserContext;
  page!: PlaywrightPage;
  cdp!: CDPSession;
  private frameNos = new Map<Frame, number>();
  private framesByNo = new Map<number, Frame>();

  private constructor(attached: boolean, view: ViewChoice | null) {
    this.attached = attached;
    this.view = view;
  }

  /** Launch a throwaway Chrome for url, or attach to the session Chrome on port. */
  static async open(url: string | null = null, options: OpenOptions = {}): Promise<Browser> {
    const port = options.port ?? null;
    const endpoint = options.endpoint ?? null;
    const instance = new Browser(port !== null || endpoint !== null, options.view ?? null);
    instance.keepsTab = options.rememberTab ?? true;
    instance.tracksWindows = options.trackWindows ?? false;
    instance.compat = options.compat ?? false;
    try {
      if (port !== null || endpoint !== null) {
        instance.browser = endpoint
          ? await chromium.connectOverCDP(endpoint.url, { headers: endpoint.headers })
          : await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        instance.context = instance.browser.contexts()[0] ?? (await instance.browser.newContext());
        await instance.findPlaceholder();
        if (url) {
          // A saved profile may restore old tabs. The run owns exactly one fresh tab.
          const stale = instance.openTabs();
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

  /** Lightpanda lists a placeholder tab that is no page: nothing can attach to it and it hangs on close. It is never a tab. */
  private placeholder: PlaywrightPage | null = null;

  private async findPlaceholder(): Promise<void> {
    for (const page of this.context.pages()) {
      if ((await this.tabId(page)) === null) this.placeholder = page;
    }
  }

  private openTabs(): PlaywrightPage[] {
    return this.context.pages().filter((page) => !page.isClosed() && page !== this.placeholder);
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
    const file = tabPath();
    if (pages.length > 1 && existsSync(file)) {
      const wanted = readFileSync(file, "utf8").trim();
      for (const page of pages) if ((await this.tabId(page)) === wanted) return page;
    }
    return pages[0];
  }

  private async rememberTab(): Promise<void> {
    if (!this.attached || !this.keepsTab) return;
    const id = await this.tabId(this.page);
    if (id === null) return;
    mkdirSync(sessionHome(), { recursive: true });
    writeFileSync(tabPath(), id, { encoding: "utf8", mode: 0o600 });
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
      // Bringing a tab to the front only matters with a window. An engine without the method (Obscura) still switches.
      await target.bringToFront().catch((error: Error) => {
        if (!/Unknown .*method|not (implemented|supported)|wasn't found/i.test(error.message)) throw error;
      });
      await this.cdp?.detach().catch(() => {});
      this.page = target;
      this.cdp = next;
    } catch {
      throw new StalePage("Tab could not be switched to", ["tab_gone"]);
    }
    await this.rememberTab();
  }

  /**
   * The session's cookies and localStorage, to be saved as a login. Nothing on any page changes. Playwright only knows
   * the localStorage of pages it saw load, and each command is a new connection, so the sites of the open tabs are read
   * directly. A site the session visited and left is not in it.
   */
  async storageState(): Promise<StorageState> {
    const state = await this.context.storageState();
    for (const page of this.openTabs()) {
      let origin: string;
      try {
        origin = new URL(page.url()).origin;
      } catch {
        continue;
      }
      if (!/^https?:/.test(origin) || state.origins.some((known) => known.origin === origin)) continue;
      try {
        const items: { name: string; value: string }[] = await page.evaluate(() =>
          Object.entries(localStorage).map(([name, value]) => ({ name, value: String(value) })),
        );
        if (items.length) state.origins.push({ origin, localStorage: items });
      } catch {
        // A page that refuses storage (an opaque origin) has none to keep.
      }
    }
    return state;
  }

  /**
   * Signs this browser in with a saved state and opens url. Cookies go in before the page loads. localStorage can only
   * be written from a page of its own site, so it is set for the site of url and the page is loaded once more.
   * Returns the sites whose localStorage could not be restored.
   */
  async restore(state: StorageState, url: string): Promise<string[]> {
    if (state.cookies.length) await this.context.addCookies(state.cookies);
    await this.page.goto(url, { waitUntil: "load" });
    const here = new URL(this.page.url()).origin;
    const items = state.origins.find((origin) => origin.origin === here)?.localStorage ?? [];
    if (items.length) {
      await this.evaluate(
        `(() => { for (const [k, v] of ${JSON.stringify(items.map((item) => [item.name, item.value]))}) localStorage.setItem(k, v); })()`,
      );
      await this.page.goto(url, { waitUntil: "load" });
    }
    return state.origins.filter((origin) => origin.origin !== here && origin.localStorage.length).map((o) => o.origin);
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

  /** The page's frames, the main one first. For tests. */
  frames(): Frame[] {
    return this.page.frames();
  }

  private frameNo(frame: Frame): number {
    let no = this.frameNos.get(frame);
    if (no === undefined) {
      no = this.frameNos.size + 1;
      this.frameNos.set(frame, no);
      this.framesByNo.set(no, frame);
    }
    return no;
  }

  /** Evaluates in the frame the node belongs to. Null when that frame is gone. */
  // biome-ignore lint/suspicious/noExplicitAny: page values are untyped JSON.
  private async evaluateFor(node: unknown, expression: string): Promise<any> {
    const no = frameOf(node);
    if (no === 0) return this.evaluate(expression);
    const frame = this.framesByNo.get(no);
    if (!frame || frame.isDetached()) return null;
    try {
      return (await frame.evaluate(expression)) ?? null;
    } catch {
      throw new StalePage("Document changed during evaluation");
    }
  }

  /** Where a frame's own viewport starts, in the main page's viewport; null when it has no size. */
  private async frameOffset(frame: Frame): Promise<{ x: number; y: number } | null> {
    const element = await frame.frameElement().catch(() => null);
    if (!element) return null;
    try {
      const box = await element.boundingBox();
      if (!box || box.width < MIN_FRAME_SIDE || box.height < MIN_FRAME_SIDE) return null;
      const [left, top] = await element.evaluate((e) => [(e as Element).clientLeft, (e as Element).clientTop]);
      return { x: box.x + left, y: box.y + top };
    } catch {
      return null;
    } finally {
      await element.dispose().catch(() => {});
    }
  }

  /**
   * Reads one frame: seeds it, observes it, and says whether it sits directly in the main frame. A frame that
   * changes or goes while it is read is left out (reason "error"); the page's own elements stand.
   */
  private async readFrame(
    frame: Frame,
    main: Frame,
  ): Promise<{ no: number; inner: Page; direct: boolean } | { skip: string }> {
    try {
      if (!(await this.frameOffset(frame))) return { skip: "no_size" };
      const no = this.frameNo(frame);
      await frame.evaluate(seedFrame(no));
      const inner = (await frame.evaluate(readState(this.view))) as Page | null;
      if (!inner) return { skip: "no_page" };
      return { no, inner, direct: frame.parentFrame() === main };
    } catch {
      return { skip: "error" };
    }
  }

  /** v2: the elements of the frames in the page, appended to the page's own, before its scroll and wait controls. */
  private async observeFrames(state: Page): Promise<void> {
    if (!this.view?.whole || this.compat) return;
    const main = this.page.mainFrame();
    const frames = this.page.frames().filter((f) => f !== main && !f.isDetached());
    const added: Action[] = [];
    const keys: Record<string, unknown> = {};
    const markers: Record<string, unknown> = {};
    const skipped: Record<string, number> = {};
    const skip = (reason: string) => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    };
    let direct = 0;
    for (const frame of frames) {
      if (Object.keys(keys).length >= MAX_FRAMES) {
        skip("over_limit");
        continue;
      }
      const read = await this.readFrame(frame, main);
      if ("skip" in read) {
        skip(read.skip);
        continue;
      }
      const { no, inner } = read;
      keys[String(no)] = inner.page_key;
      markers[String(no)] = inner.marker;
      Object.assign(state.guards, inner.guards);
      for (const action of inner.actions) {
        if (["scroll", "wait", "tab"].includes(action.kind)) continue;
        added.push({ ...action, frame: no, region: `frame_${no}` });
      }
      const text = String(inner.text ?? "")
        .trim()
        .slice(0, FRAME_TEXT_LIMIT);
      if (text) state.text = `${state.text}\n[frame ${no}] ${text}`;
      if (read.direct) direct++;
    }
    // For the run log (counts only): the frames read and why the others were not.
    if (frames.length) {
      state.frames_log = { found: frames.length, read: Object.keys(keys).length, elements: added.length, skipped };
    }
    if (!added.length && !Object.keys(keys).length) return;
    state.frame_keys = keys;
    // What the frames showed, so that a change inside a frame counts as the page having changed (not in `marker`, which
    // the freshness check compares with the main page alone).
    state.frame_markers = markers;
    const at = state.actions.findIndex((a: Action) => ["scroll", "wait"].includes(a.kind));
    state.actions.splice(at < 0 ? state.actions.length : at, 0, ...added);
    let n = 0;
    for (const action of state.actions) if (/^e\d+$/.test(action.id)) action.id = `e${++n}`;
    if (state.status?.unseen) state.status.unseen.frames = Math.max(0, state.status.unseen.frames - direct);
  }

  async observe(): Promise<Page> {
    await this.leaveClosedTab();
    for (let i = 0; i < 10; i++) {
      let state: Page | null;
      try {
        await this.evaluate(settleScript(), { awaitPromise: true });
        if (this.compat) await this.evaluate(COMPAT);
        if (this.tracksWindows) await this.evaluate(TRACK_WINDOWS);
        state = await this.evaluate(readState(this.view));
        // v2: what kind of page this is, for Jev and Claude.
        if (state !== null && this.view?.whole) state.status = await this.evaluate(STATUS);
        if (state !== null) await this.observeFrames(state);
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
      const current = await this.evaluateFor(
        node,
        "(() => { const c=window.__browserLab; " +
          `return c ? [c.pageKey(),c.guard(c.nodes.get(${node}))] : null; })()`,
      );
      if (current === null) return ["snapshot_gone"];
      const guard = page.guards?.[String(node)] ?? null;
      const key = frameOf(node) === 0 ? page.page_key : page.frame_keys?.[String(frameOf(node))];
      return [
        ...differing(current[0], key, PAGE_KEY_PARTS),
        ...(current[1] === null && guard !== null ? ["target_gone"] : differing(current[1], guard, GUARD_PARTS)),
      ];
    }
    const marker = await this.evaluate(MARKER);
    return marker === null && page.marker != null ? ["snapshot_gone"] : differing(marker, page.marker, MARKER_PARTS);
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

  /**
   * Where to click the action's element. When it is covered or outside the viewport, it is scrolled to the
   * middle once and tried again: a sticky header or a fixed bar often covers an element near an edge. Otherwise
   * StalePage, saying what covers it, so Jev can deal with that first. Nothing is clicked or typed here.
   */
  private async target(action: Action): Promise<{ x: number; y: number }> {
    const no = frameOf(action.node);
    const resolve = async () => {
      const found = (await this.evaluateFor(action.node, `${RESOLVE_TARGET}(${JSON.stringify(action)})`)) as
        | { x: number; y: number }
        | { reason: string; cover?: string }
        | null;
      if (found === null) return { reason: "gone" };
      if (no === 0 || "reason" in found) return found;
      // A point in a frame is clicked where the frame sits in the page's viewport.
      const frame = this.framesByNo.get(no);
      const offset = frame ? await this.frameOffset(frame) : null;
      if (!offset) return { reason: "hidden" };
      const [w, h] = await this.evaluate("[innerWidth, innerHeight]");
      const x = found.x + offset.x;
      const y = found.y + offset.y;
      return x < 0 || y < 0 || x >= w || y >= h ? { reason: "outside" } : { x, y };
    };
    let found = await resolve();
    if ("reason" in found && (found.reason === "covered" || found.reason === "outside")) {
      await this.evaluateFor(action.node, `${REVEAL}(${JSON.stringify(action.node)})`);
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
      const found = await this.evaluateFor(action.node, `${REVEAL}(${JSON.stringify(action.node)})`);
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
    if (frameOf(action.node) !== 0) {
      const done = await this.evaluateFor(action.node, `${SELECT_OPTION}(${JSON.stringify(action)})`);
      if (done !== true) throw new MutationUncertain("Dropdown change was not confirmed");
      return;
    }
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
