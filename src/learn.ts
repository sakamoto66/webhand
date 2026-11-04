/**
 * Records what a person demonstrates in a disposable Chrome. Claude turns the record into a runbook.
 *
 * The record is untrusted: pages can forge binding calls, so it only ever becomes a draft for review.
 */

import { asset, type Browser, READ_STATE } from "./browser.ts";
import type { Recorder } from "./metrics.ts";

// A function replacer: the snapshot holds "$" sequences that a string replacement would expand.
const RECORDER = asset("recorder.js").replaceAll("__SNAPSHOT__", () => READ_STATE.trim());
const FIELDS = ["operation", "role", "label", "value", "checked", "reason", "url", "title", "text", "region"];
const KINDS = new Set(["action", "page", "unsupported"]);
const MAX_REGIONS = 60;
export const REGION_FIELDS: Record<string, "str" | "int"> = {
  key: "str",
  position: "str",
  text_chars: "int",
  actions: "int",
  offscreen_actions: "int",
};

function clip(value: unknown): unknown {
  return typeof value === "string" ? [...value].slice(0, 2000).join("") : value;
}

/** The page's region outline, keeping only well-typed fields. A page can send anything here. */
export function outline(regions: unknown): Record<string, unknown>[] {
  if (!Array.isArray(regions)) return [];
  const kept: Record<string, unknown>[] = [];
  for (const region of regions.slice(0, MAX_REGIONS)) {
    if (region === null || typeof region !== "object" || Array.isArray(region)) continue;
    const fields: Record<string, unknown> = {};
    for (const [key, kind] of Object.entries(REGION_FIELDS)) {
      const value = (region as Record<string, unknown>)[key];
      if (kind === "str" && typeof value === "string") fields[key] = [...value].slice(0, 200).join("");
      if (kind === "int" && Number.isInteger(value)) fields[key] = value;
    }
    kept.push(fields);
  }
  return kept;
}

/** Records until the window closes or until() is true. Returns how many events of each kind, in first-seen order. */
export async function record(
  browser: Browser,
  url: string,
  recorder: Recorder,
  until: () => boolean | Promise<boolean>,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const started = performance.now();

  const write = (kind: string, fields: Record<string, unknown>) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    recorder.event(kind, { at_ms: Math.round(performance.now() - started), ...fields });
  };

  const receive = (_source: unknown, event: unknown) => {
    if (event === null || typeof event !== "object" || Array.isArray(event)) return;
    const data = event as Record<string, unknown>;
    if (typeof data.kind !== "string" || !KINDS.has(data.kind)) return;
    const fields: Record<string, unknown> = {};
    for (const key of FIELDS) if (key in data) fields[key] = clip(data[key]);
    if (data.kind === "page") fields.regions = outline(data.regions);
    write(data.kind, fields);
  };

  const context = browser.context;
  await context.exposeBinding("__browserLabRecord", receive);
  await context.addInitScript({ content: RECORDER });
  context.on("page", () => write("unsupported", { reason: "new_tab" }));
  await browser.page.goto(url, { waitUntil: "load" });
  while (browser.browser.isConnected() && context.pages().length && !(await until())) {
    try {
      await context.pages()[0].waitForTimeout(100);
    } catch {
      // The window closed while waiting.
    }
  }
  return counts;
}
