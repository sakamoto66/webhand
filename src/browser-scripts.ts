/**
 * The scripts that run inside the page, as strings handed to evaluate: what a page check, a status, a click target and
 * a list look like from the DOM. They read the page and never change it, except TRACK_WINDOWS and COMPAT, which
 * install a note-taker and what an engine lacks. The big snapshot is assets/snapshot.js (see browser.ts).
 */

// A frame smaller than this on either side (a tracking pixel, an ad slot) is neither read nor counted as unseen.
export const MIN_FRAME_SIDE = 20;

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

export const PAGE_CHECK = `(() => {
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
export const STATUS = `(() => {
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
export const UNSEEN = `(() => {
  const shown = e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0; };
  const count = selector => [...document.querySelectorAll(selector)].filter(shown).length;
  const framed = [...document.querySelectorAll('iframe,frame')].filter(e => { const r=e.getBoundingClientRect(); return r.width>=${MIN_FRAME_SIDE} && r.height>=${MIN_FRAME_SIDE}; }).length;
  return {frames: framed, canvases: count('canvas'), objects: count('object,embed')};
})()`;
/**
 * Notes what asks for a new window: window.open and a click on a link with target=_blank. Nothing is stopped or
 * changed; the browser does what it does. Installed once per document, and read with TAKE_WINDOWS.
 */
export const TRACK_WINDOWS = `(() => {
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
export const COMPAT = `(() => {
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
export const TAKE_WINDOWS = "(() => (window.__webhandWindows ?? []).splice(0))()";

// Read only once the document has loaded and the DOM has stopped changing, so content rendered by
// DOMContentLoaded handlers or after an XHR is observed. A page that never goes quiet is read at the cap.
const SETTLE_QUIET_MS = 150;
/** Tests of the fixtures shorten the quiet time (WEBHAND_SETTLE_QUIET_MS) to run faster; people never set it. */
const settleQuietMs = () => Number(process.env.WEBHAND_SETTLE_QUIET_MS) || SETTLE_QUIET_MS;
export const SETTLE_CAP_MS = 2000;
export const settleScript = () => `new Promise(resolve => {
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
export const RESOLVE_TARGET = `(action => {
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
export const REVEAL = `(node => {
  const e=window.__browserLab?.nodes.get(node);
  if (!e?.isConnected) return false;
  e.scrollIntoView({block: "center", inline: "nearest", behavior: "instant"});
  return true;
})`;

// The text of the row, card, or list item each observed element is in, for comparing items. Page text only;
// field values are not part of innerText.
export const CONTEXTS = `(nodes => {
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

export const ROWS = `(() => {
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
export const LIST_END = `(() => {
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

export const SELECT_OPTION = `(action => {
  const e=window.__browserLab.nodes.get(action.node);
  if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
      !o.disabled && !o.closest('optgroup[disabled]'))) return false;
  e.value=action.value;
  e.dispatchEvent(new Event('input',{bubbles:true}));
  e.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
})`;
