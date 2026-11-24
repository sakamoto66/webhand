/** Per-kind action execution handlers (wait, tab, reveal, upload, scroll, select, hover, click, fill). */

import { existsSync } from "node:fs";
import type { ElementHandle, Page as PlaywrightPage } from "playwright-core";
import { sleep } from "../../core/format.ts";
import { type Action, MutationUncertain, type Page, PolicyError, StalePage } from "../../core/types.ts";
import type { DownloadTracker } from "../downloads.ts";
import { frameOf } from "../frames.ts";
import { IS_FOCUSED, RESOLVE_TARGET, REVEAL, SELECT_OPTION } from "../scripts/index.ts";
import { type ClickPoint, resolveClickTarget, type TargetContext } from "./target.ts";

export interface ActionContext extends TargetContext {
  page: PlaywrightPage;
  downloads: DownloadTracker;
  // biome-ignore lint/suspicious/noExplicitAny: CDP methods and results are untyped here.
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  switchTab(action: Action, page: Page): Promise<void>;
}

interface ActionHandler {
  /** If true, errors thrown during run() are wrapped in MutationUncertain (never retried). */
  mutates?: boolean;
  /** If true, resolves viewport click coordinates before calling run(). */
  needsTarget?: boolean;
  run(ctx: ActionContext, action: Action, page: Page, text: string | null, point: ClickPoint | null): Promise<void>;
}

async function click(ctx: ActionContext, x: number, y: number): Promise<void> {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await ctx.call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

async function replaceText(ctx: ActionContext, text: string | null): Promise<void> {
  if (text === null) throw new MutationUncertain("Field was focused without text");
  const modifiers = process.platform === "darwin" ? 4 : 2;
  const key = { key: "a", code: "KeyA", modifiers };
  await ctx.call("Input.dispatchKeyEvent", { type: "keyDown", commands: ["selectAll"], ...key });
  await ctx.call("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  await ctx.call("Input.insertText", { text });
}

async function selectOption(ctx: ActionContext, action: Action): Promise<void> {
  if (frameOf(action.node) !== 0) {
    const done = await ctx.evaluateFor(action.node, `${SELECT_OPTION}(${JSON.stringify(action)})`);
    if (done !== true) throw new MutationUncertain("Dropdown change was not confirmed");
    return;
  }
  const response = await ctx.call("Runtime.evaluate", {
    expression: `${SELECT_OPTION}(${JSON.stringify(action)})`,
    returnByValue: true,
  });
  if (response?.result?.value !== true) throw new MutationUncertain("Dropdown change was not confirmed");
}

async function uploadFile(ctx: ActionContext, action: Action, path: string | null): Promise<void> {
  if (path === null) throw new PolicyError("No file was chosen for the upload");
  if (!existsSync(path)) throw new MutationUncertain("The file to upload is gone");
  if (!action.hidden) {
    const found = (await ctx.evaluateFor(action.node, `${RESOLVE_TARGET}(${JSON.stringify(action)})`)) as {
      reason?: string;
    } | null;
    if (found === null || (found.reason && found.reason !== "covered" && found.reason !== "outside")) {
      throw new StalePage(`Target is ${found?.reason ?? "gone"}`, [`target_${found?.reason ?? "gone"}`]);
    }
  }
  const no = frameOf(action.node);
  const frame = no === 0 ? ctx.page.mainFrame() : ctx.frames.get(no);
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

const CLICK_HANDLER: ActionHandler = {
  mutates: true,
  needsTarget: true,
  async run(ctx, _action, _page, _text, point) {
    const { x, y } = point as ClickPoint;
    await click(ctx, x, y);
  },
};

const ACTION_HANDLERS: Record<string, ActionHandler> = {
  wait: {
    async run() {
      await sleep(100);
    },
  },
  tab: {
    async run(ctx, action, page) {
      await ctx.switchTab(action, page);
    },
  },
  reveal: {
    async run(ctx, action) {
      const found = await ctx.evaluateFor(action.node, `${REVEAL}(${JSON.stringify(action.node)})`);
      if (!found) throw new StalePage("Target changed", ["target_gone"]);
    },
  },
  upload: {
    async run(ctx, action, _page, text) {
      await uploadFile(ctx, action, text);
    },
  },
  scroll: {
    mutates: true,
    async run(ctx, action) {
      await ctx.call("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 550,
        y: 650,
        deltaX: 0,
        deltaY: action.delta,
      });
    },
  },
  select: {
    mutates: true,
    needsTarget: true,
    async run(ctx, action) {
      await selectOption(ctx, action);
    },
  },
  hover: {
    mutates: true,
    needsTarget: true,
    async run(ctx, _action, _page, _text, point) {
      const { x, y } = point as ClickPoint;
      await ctx.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sleep(150);
    },
  },
  click: CLICK_HANDLER,
  fill: {
    mutates: true,
    needsTarget: true,
    async run(ctx, action, _page, text, point) {
      const { x, y, widget } = point as ClickPoint;
      await click(ctx, x, y);
      if (widget) {
        await sleep(50);
        const focused = await ctx.evaluateFor(action.node, `${IS_FOCUSED}(${JSON.stringify(action.node)})`);
        if (focused !== true) throw new MutationUncertain("Editor did not receive focus after click");
      }
      await replaceText(ctx, text);
    },
  },
};

export async function dispatchAction(
  ctx: ActionContext,
  action: Action,
  page: Page,
  text: string | null,
): Promise<void> {
  const kind = String(action.kind);
  const handler = ACTION_HANDLERS[kind] ?? CLICK_HANDLER;
  const point = handler.needsTarget ? await resolveClickTarget(ctx, action) : null;
  if (!handler.mutates) {
    await handler.run(ctx, action, page, text, point);
    return;
  }
  try {
    await handler.run(ctx, action, page, text, point);
  } catch (error) {
    if (error instanceof MutationUncertain) throw error;
    throw new MutationUncertain(`${kind} was interrupted`);
  }
  if (kind === "click") await ctx.downloads.collect();
}
