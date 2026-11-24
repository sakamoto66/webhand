/** Resolves viewport click coordinates for an observed element, scrolling once when covered or outside. */

import { sleep } from "../../core/format.ts";
import { type Action, StalePage } from "../../core/types.ts";
import { type FrameRegistry, frameOf } from "../frames.ts";
import { RESOLVE_TARGET, REVEAL } from "../scripts/index.ts";

export interface ClickPoint {
  x: number;
  y: number;
  widget?: boolean;
}

export interface TargetContext {
  frames: FrameRegistry;
  // biome-ignore lint/suspicious/noExplicitAny: page values are untyped JSON.
  evaluate(expression: string): Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: page values are untyped JSON.
  evaluateFor(node: unknown, expression: string): Promise<any>;
}

/**
 * Where to click the action's element. When it is covered or outside the viewport, it is scrolled to the
 * middle once and tried again: a sticky header or a fixed bar often covers an element near an edge. Otherwise
 * StalePage, saying what covers it, so Jev can deal with that first. Nothing is clicked or typed here.
 */
export async function resolveClickTarget(ctx: TargetContext, action: Action): Promise<ClickPoint> {
  const no = frameOf(action.node);
  const resolve = async (): Promise<ClickPoint | { reason: string; cover?: string }> => {
    const found = (await ctx.evaluateFor(action.node, `${RESOLVE_TARGET}(${JSON.stringify(action)})`)) as
      | ClickPoint
      | { reason: string; cover?: string }
      | null;
    if (found === null) return { reason: "gone" };
    if (no === 0 || "reason" in found) return found;
    // A point in a frame is clicked where the frame sits in the page's viewport.
    const frame = ctx.frames.get(no);
    const offset = frame ? await ctx.frames.offset(frame) : null;
    if (!offset) return { reason: "hidden" };
    const [w, h] = await ctx.evaluate("[innerWidth, innerHeight]");
    const x = found.x + offset.x;
    const y = found.y + offset.y;
    return x < 0 || y < 0 || x >= w || y >= h
      ? { reason: "outside" }
      : { x, y, ...(found.widget ? { widget: true } : {}) };
  };
  let found = await resolve();
  if ("reason" in found && (found.reason === "covered" || found.reason === "outside")) {
    await ctx.evaluateFor(action.node, `${REVEAL}(${JSON.stringify(action.node)})`);
    await sleep(100);
    found = await resolve();
  }
  if (!("reason" in found)) return found;
  if (found.reason === "covered") {
    throw new StalePage(`Target is covered by ${found.cover}; deal with that first`, ["target_covered"]);
  }
  throw new StalePage(`Target is ${found.reason.replace("_", "-")}`, [`target_${found.reason}`]);
}
