/** Playwright launches an isolated Chrome or attaches to the session Chrome; observation and input go through one CDP session. */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type BrowserContext,
  type CDPSession,
  chromium,
  type Download,
  type ElementHandle,
  type Frame,
  type Browser as PlaywrightBrowser,
  type Page as PlaywrightPage,
} from "playwright-core";
import type { StorageState } from "./auth.ts";
import {
  COMPAT,
  CONTEXTS,
  LIST_END,
  MIN_FRAME_SIDE,
  PAGE_CHECK,
  RESOLVE_TARGET,
  REVEAL,
  ROWS,
  SELECT_OPTION,
  STATUS,
  settleScript,
  TAKE_WINDOWS,
  TRACK_WINDOWS,
  UNSEEN,
} from "./browser-scripts.ts";
import { clip, dedupe, type Finding, hostAllowed, plainUrl } from "./explore.ts";
import { sleep } from "./format.ts";
import { home as sessionHome, tabPath } from "./session.ts";
import { type Action, MutationUncertain, type Page, PolicyError, StalePage } from "./types.ts";

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

/** What a run log needs to tell a block from a page that did not load. */
export interface PageCheck {
  http_status: number | null; // The main document's status; null when the browser records none (about:blank).
  title: string;
  challenge: string[];
  text_chars: number; // Visible text length; near 0 is a blank or still-loading page.
}

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
const MAX_TAB_TITLE = 60;
const DOWNLOAD_START_MS = 1500;
const DOWNLOAD_DONE_MS = 60_000;

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
  /** Where Chrome saves files the page downloads. Absolute; made if missing. Local Chrome only. */
  downloadDir?: string | null;
  /** Exploring: refuse requests to hosts outside this list, and note what the pages report going wrong. Local Chrome only. */
  explore?: { allow: string[] } | null;
  /** Fill in what the engine lacks (Obscura: iterable select.selectedOptions) so snapshot.js reads the page as in Chrome. */
  compat?: boolean;
}

export class Browser {
  view: ViewChoice | null;
  readonly attached: boolean;
  private keepsTab = true;
  private tracksWindows = false;
  private compat = false;
  private downloadDir: string | null = null;
  /** Files that appeared in the download directory during the last act, by name. Taken once. */
  private downloaded: { name: string; bytes: number }[] = [];
  private saving: Promise<unknown>[] = [];
  private found: Finding[] = [];
  /** Requests this run refused itself: their failure is the refusal, not a finding of its own. */
  private refused = new WeakSet<object>();
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
    instance.downloadDir = options.downloadDir ?? null;
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
        await instance.allowDownloads();
        await instance.watchPages(options.explore ?? null);
        await instance.rememberTab();
        return instance;
      }
      // launch() uses a throwaway profile. Never point this at a signed-in profile.
      instance.browser = await chromium.launch({ channel: "chrome", headless: options.headless ?? true });
      instance.context = await instance.browser.newContext({ viewport: { width: 1120, height: 780 } });
      instance.page = await instance.context.newPage();
      instance.cdp = await instance.context.newCDPSession(instance.page);
      await instance.allowDownloads();
      if (url) await instance.page.goto(url, { waitUntil: "load" });
      return instance;
    } catch (error) {
      await instance.close();
      throw error;
    }
  }

  /**
   * Exploring: notes what the pages report going wrong (console errors, uncaught errors, 5xx responses, failed
   * requests) and refuses every request to a host outside the allowed ones, so a link cannot take the run out of the
   * test environment. Passive: nothing here acts on a page.
   */
  private async watchPages(explore: { allow: string[] } | null): Promise<void> {
    if (!explore) return;
    const note = (finding: Finding) => this.found.push(finding);
    const watch = (page: PlaywrightPage) => {
      page.on("console", (message) => {
        // A failed resource is reported by its response or request already.
        if (message.type() === "error" && !/^Failed to load resource/.test(message.text())) {
          note({ signal: "console_error", url: plainUrl(page.url()), detail: clip(message.text()) });
        }
      });
      page.on("pageerror", (error) => {
        note({ signal: "pageerror", url: plainUrl(page.url()), detail: clip(error.message) });
      });
      page.on("response", (response) => {
        if (response.status() >= 500) {
          note({ signal: "http_5xx", url: plainUrl(response.url()), detail: "", status: response.status() });
        }
      });
      page.on("requestfailed", (request) => {
        const reason = request.failure()?.errorText ?? "";
        // Cancelled requests are what navigation does; a refusal of ours is reported once, as out_of_scope.
        if (this.refused.has(request) || /ERR_ABORTED/.test(reason)) return;
        note({ signal: "request_failed", url: plainUrl(request.url()), detail: clip(reason) });
      });
    };
    for (const page of this.context.pages()) watch(page);
    this.context.on("page", watch);
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      if (hostAllowed(request.url(), explore.allow)) return route.continue();
      this.refused.add(request);
      note({ signal: "out_of_scope", url: plainUrl(request.url()), detail: "" });
      return route.abort("blockedbyclient");
    });
  }

  /** What exploring noted since the last call, once each. */
  takeFindings(): Finding[] {
    return dedupe(this.found.splice(0));
  }

  /** Saves what the pages download into the download directory. Playwright holds a download until it is saved. */
  private async allowDownloads(): Promise<void> {
    if (!this.downloadDir) return;
    mkdirSync(this.downloadDir, { recursive: true });
    const watch = (page: PlaywrightPage) => {
      page.on("download", (download) => {
        this.saving.push(this.save(download).catch(() => null));
      });
    };
    for (const page of this.context.pages()) watch(page);
    this.context.on("page", watch);
  }

  private async save(download: Download): Promise<void> {
    const dir = this.downloadDir as string;
    const wanted = basename(download.suggestedFilename()) || "download";
    const dot = wanted.lastIndexOf(".");
    const [stem, extension] = dot > 0 ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ""];
    let name = wanted;
    // Never over an existing file: a repeated name gets " (1)".
    for (let n = 1; existsSync(join(dir, name)); n++) name = `${stem} (${n})${extension}`;
    await download.saveAs(join(dir, name));
    this.downloaded.push({ name, bytes: statSync(join(dir, name)).size });
  }

  /** The files the last act downloaded, once. */
  takeDownloads(): { name: string; bytes: number }[] {
    const found = this.downloaded;
    this.downloaded = [];
    return found;
  }

  /** After an input that may start a download: waits for one to begin, then for every one to be saved. */
  private async collectDownloads(): Promise<void> {
    if (!this.downloadDir) return;
    const started = Date.now();
    while (Date.now() - started < DOWNLOAD_START_MS && this.saving.length === 0) await sleep(100);
    const saving = this.saving.splice(0);
    if (!saving.length) return;
    await Promise.race([Promise.all(saving), sleep(DOWNLOAD_DONE_MS)]);
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
    const targeted = ["click", "select", "reveal", "upload", ...(this.view?.whole ? ["fill"] : [])];
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
    if (kind === "upload") return await this.upload(action, text);
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
    if (kind === "click") await this.collectDownloads();
  }

  /** Gives a file input the file. The path is Claude's, checked when it was given; the model never wrote it. */
  private async upload(action: Action, path: string | null): Promise<void> {
    if (path === null) throw new PolicyError("No file was chosen for the upload");
    if (!existsSync(path)) throw new MutationUncertain("The file to upload is gone");
    // A file input the page hides is given its file where it is; its visible trigger was checked when observed.
    if (!action.hidden) {
      const found = (await this.evaluateFor(action.node, `${RESOLVE_TARGET}(${JSON.stringify(action)})`)) as {
        reason?: string;
      } | null;
      if (found === null || (found.reason && found.reason !== "covered" && found.reason !== "outside")) {
        throw new StalePage(`Target is ${found?.reason ?? "gone"}`, [`target_${found?.reason ?? "gone"}`]);
      }
    }
    const no = frameOf(action.node);
    const frame = no === 0 ? this.page.mainFrame() : this.framesByNo.get(no);
    if (!frame || frame.isDetached()) throw new StalePage("Target changed", ["target_gone"]);
    const handle = await frame.evaluateHandle(`window.__browserLab.nodes.get(${JSON.stringify(action.node)}) ?? null`);
    const element = handle.asElement() as ElementHandle | null;
    try {
      if (!element) throw new StalePage("Target changed", ["target_gone"]);
      await element.setInputFiles(path);
    } catch (error) {
      if (error instanceof StalePage) throw error;
      throw new MutationUncertain("The upload was interrupted");
    } finally {
      await handle.dispose().catch(() => {});
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
