/**
 * v2 iframe support: elements inside frames are observed in place, one snapshot per visible frame.
 * A node id encodes its frame: frame number * FRAME_BASE + the frame's own snapshot id (main page is 0).
 */

import type { Frame, Page as PlaywrightPage } from "playwright-core";
import { type Action, type Page, StalePage } from "../core/types.ts";
import { MIN_FRAME_SIDE } from "./scripts/index.ts";
import { readState, type ViewChoice } from "./snapshot.ts";

const FRAME_BASE = 1_000_000;
const MAX_FRAMES = 8;
const FRAME_TEXT_LIMIT = 1500;

export function frameOf(node: unknown): number {
  return Number.isInteger(node) ? Math.floor((node as number) / FRAME_BASE) : 0;
}

const seedFrame = (no: number) =>
  `(() => { const c = (window.__browserLab ||= {ids: new WeakMap(), nodes: new Map(), next: 1}); ` +
  `if (c.next < ${no * FRAME_BASE}) c.next = ${no * FRAME_BASE}; })()`;

export class FrameRegistry {
  private readonly frameNos = new Map<Frame, number>();
  private readonly framesByNo = new Map<number, Frame>();

  private frameNo(frame: Frame): number {
    let no = this.frameNos.get(frame);
    if (no === undefined) {
      no = this.frameNos.size + 1;
      this.frameNos.set(frame, no);
      this.framesByNo.set(no, frame);
    }
    return no;
  }

  get(no: number): Frame | undefined {
    return this.framesByNo.get(no);
  }

  /** Evaluates in the frame the node belongs to. Null when that frame is gone. */
  // biome-ignore lint/suspicious/noExplicitAny: page values are untyped JSON.
  async evaluateFor(node: unknown, expression: string, evalMain: (expression: string) => Promise<any>): Promise<any> {
    const no = frameOf(node);
    if (no === 0) return evalMain(expression);
    const frame = this.framesByNo.get(no);
    if (!frame || frame.isDetached()) return null;
    try {
      return (await frame.evaluate(expression)) ?? null;
    } catch {
      throw new StalePage("Document changed during evaluation");
    }
  }

  /** Where a frame's own viewport starts, in the main page's viewport; null when it has no size. */
  async offset(frame: Frame): Promise<{ x: number; y: number } | null> {
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

  /** Reads one frame: seeds it, observes it, and says whether it sits directly in the main frame. */
  private async readFrame(
    frame: Frame,
    main: Frame,
    view: ViewChoice | null,
  ): Promise<{ no: number; inner: Page; direct: boolean } | { skip: string }> {
    try {
      if (!(await this.offset(frame))) return { skip: "no_size" };
      const no = this.frameNo(frame);
      await frame.evaluate(seedFrame(no));
      const inner = (await frame.evaluate(readState(view))) as Page | null;
      if (!inner) return { skip: "no_page" };
      return { no, inner, direct: frame.parentFrame() === main };
    } catch {
      return { skip: "error" };
    }
  }

  /** v2: appends elements of visible frames to the page's own actions, before scroll and wait controls. */
  async observe(page: PlaywrightPage, state: Page, view: ViewChoice | null, compat: boolean): Promise<void> {
    if (!view?.whole || compat) return;
    const main = page.mainFrame();
    const frames = page.frames().filter((f) => f !== main && !f.isDetached());
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
      const read = await this.readFrame(frame, main, view);
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
    if (frames.length) {
      state.frames_log = { found: frames.length, read: Object.keys(keys).length, elements: added.length, skipped };
    }
    if (!added.length && !Object.keys(keys).length) return;
    state.frame_keys = keys;
    state.frame_markers = markers;
    const at = state.actions.findIndex((a: Action) => ["scroll", "wait"].includes(a.kind));
    state.actions.splice(at < 0 ? state.actions.length : at, 0, ...added);
    let n = 0;
    for (const action of state.actions) if (/^e\d+$/.test(action.id)) action.id = `e${++n}`;
    if (state.status?.unseen) state.status.unseen.frames = Math.max(0, state.status.unseen.frames - direct);
  }
}
