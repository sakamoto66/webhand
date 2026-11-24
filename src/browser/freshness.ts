/**
 * Freshness comparison between an observed Page snapshot and the live DOM just before an action runs.
 * Returns the named parts that differed (empty when fresh), used for StalePage and the run log.
 */

import { isDeepStrictEqual } from "node:util";
import type { Action, Page } from "../core/types.ts";
import { frameOf } from "./frames.ts";
import { MARKER } from "./snapshot.ts";

// The parts of the freshness keys in snapshot (viewportKey, pageKey, guard, marker), by position.
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
// v2: what the freshness check leaves out.
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

export interface FreshnessEvaluator {
  // biome-ignore lint/suspicious/noExplicitAny: page values are untyped JSON.
  evaluate(expression: string): Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: page values are untyped JSON.
  evaluateFor(node: unknown, expression: string): Promise<any>;
  whole: boolean;
}

async function differingParts(ctx: FreshnessEvaluator, page: Page, action: Action | null): Promise<string[]> {
  // v2 checks typing against its field too, instead of against the whole viewport's text.
  const targeted = ["click", "hover", "select", "reveal", "upload", ...(ctx.whole ? ["fill"] : [])];
  if (action !== null && targeted.includes(action.kind)) {
    const node = action.node;
    if (!Number.isInteger(node)) return ["target_unknown"];
    const current = await ctx.evaluateFor(
      node,
      `(() => { const c=window.__browserLab; return c ? [c.pageKey(),c.guard(c.nodes.get(${node}))] : null; })()`,
    );
    if (current === null) return ["snapshot_gone"];
    const guard = page.guards?.[String(node)] ?? null;
    const key = frameOf(node) === 0 ? page.page_key : page.frame_keys?.[String(frameOf(node))];
    return [
      ...differing(current[0], key, PAGE_KEY_PARTS),
      ...(current[1] === null && guard !== null ? ["target_gone"] : differing(current[1], guard, GUARD_PARTS)),
    ];
  }
  const marker = await ctx.evaluate(MARKER);
  return marker === null && page.marker != null ? ["snapshot_gone"] : differing(marker, page.marker, MARKER_PARTS);
}

/** What differs from the observation: nothing when fresh. The parts are named for the run log only. */
export async function staleParts(ctx: FreshnessEvaluator, page: Page, action: Action | null = null): Promise<string[]> {
  // A compare or collect scan's own scroll: no decision to be stale.
  if (action?.scan) return [];
  const parts = await differingParts(ctx, page, action);
  if (!ctx.whole) return parts;
  // Scrolling and waiting change nothing on the page, and waiting is for the page to change.
  if (action !== null && UNCHANGING.has(action.kind)) return [];
  if (action === null) return parts.filter((part) => !V2_IGNORED_PAGE.has(part));
  const item = page.guards?.[String(action.node)]?.[14] === "item";
  return parts.filter((part) => !V2_IGNORED.has(part) && (item || part !== "scope_text"));
}
