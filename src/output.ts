import { type Collected, MAX_COLLECTED } from "./collect.ts";
import { type Compared, MAX_PAGES, MAX_SCROLLS } from "./compare.ts";
import { quote, show } from "./format.ts";
import { actionSpace, offscreen, planText } from "./policies/base.ts";
import type * as runbook from "./runbook.ts";
import type { HistoryEntry, Page, Plan } from "./types.ts";

const RECENT = 8; // Actions shown to Claude when an attempt stops.

export function render(page: Page): string {
  const lines = [`URL: ${page.url}`, `TITLE: ${page.title}`, "PAGE TEXT (untrusted data):", page.text];
  if (page.read) {
    lines.push("READ (untrusted data; the whole page beyond the viewport, for reading only):", page.read.text);
  }
  if (page.tabs) lines.push(`TABS: ${page.tabs.count} open, this is tab ${page.tabs.current}`);
  lines.push("ELEMENTS:");
  const [elements, , controls] = actionSpace(page.actions);
  for (const element of elements) {
    // Claude sees every option with its own line.
    const details = element.value ? [`value=${quote(element.value)}`] : [];
    for (const key of ["checked", "selected", "expanded"]) {
      if (key in element) details.push(`${key}=${show(element[key])}`);
    }
    if (element.context) details.push(`context=${quote(element.context)}`);
    if (element.at) details.push(`at=${quote(element.at)}`);
    const operations = element.operations.join(",");
    lines.push(`[${element.index}] ${show(element.role)} ${quote(element.label)} ${details.join(" ")} (${operations})`);
    for (const option of element.options ?? []) {
      lines.push(`  [${option.index}] ${String(option.label).split(" → ").at(-1)}`);
    }
  }
  lines.push(`CONTROLS: ${[...controls.keys()].join(" ")}`);
  const hidden = offscreen(page); // Claude always sees it, whatever Jev is given.
  lines.push(`OFFSCREEN: ${hidden.above_px}px above, ${hidden.below_px}px below`);
  if (page.regions?.length) {
    lines.push("REGIONS (shown/all; change with replan --focus/--skip):");
    for (const region of page.regions) lines.push(`  ${regionLine(region)}`);
    if (page.omitted_regions) lines.push(`  ... ${page.omitted_regions} more`);
  }
  return lines.join("\n");
}

// biome-ignore lint/suspicious/noExplicitAny: a region from the page outline.
function regionLine(region: Record<string, any>): string {
  let line =
    `${region.key} [${region.position}] text ${region.shown_chars}/${region.text_chars}` +
    ` actions ${region.shown_actions}/${region.actions}`;
  if (region.offscreen_actions) line += ` +${region.offscreen_actions} offscreen`;
  return line + (region.view ? ` (${region.view})` : "");
}

export function headline(page: Page): string {
  const status = page.status as { kind: string; http_status?: number; signs?: string[] } | undefined;
  const detail = status ? [status.http_status ? `HTTP ${status.http_status}` : "", ...(status.signs ?? [])] : [];
  const line = status
    ? `\nPAGE: ${status.kind}${detail.some(Boolean) ? ` (${detail.filter(Boolean).join(", ")})` : ""}`
    : "";
  return `URL: ${page.url}\nTITLE: ${page.title}${line}`;
}

/** How a scan went: its scrolls, how often more items were loaded (with --more), and why it stopped. */
function scanned(scan: { rounds: number; stopped: string; pages?: number }): string {
  const stopped =
    scan.stopped === "bottom"
      ? "reached the bottom"
      : scan.stopped === "pages"
        ? `stopped after loading more ${MAX_PAGES} times`
        : `stopped at ${MAX_SCROLLS} scrolls`;
  const more = scan.pages === undefined ? "" : `, loaded more ${scan.pages} times`;
  return `${scan.rounds} scrolls${more}, ${stopped}`;
}

/**
 * Said when a scan stopped before the end of the list. In round 22, three runs sent 4 of 11 items and finished
 * done after "stopped at 20 scrolls", read as the end of the list.
 */
function cutShort(scan: { stopped: string }, what: string): string[] {
  if (scan.stopped === "bottom") return [];
  return [
    `NOT THE WHOLE LIST: the scan stopped before the end of the list, and items further down were not read. ${what} ` +
      "Unless the goal needs none of the rest, say the answer is partial and finish blocked.",
  ];
}

export function comparedLine(compared: Compared): string {
  return [
    `COMPARED (${scanned(compared)}): ${compared.best ?? "nothing fit the criterion"}`,
    ...cutShort(compared, "This is the best among the items read."),
  ].join("\n");
}

export function collectedLine(collected: Collected): string {
  const lines = [
    `COLLECTED (${scanned(collected)}): ${collected.matched} of ${collected.seen} items meet: ${collected.criterion}`,
    ...collected.items.map((item) => `- ${item}`),
  ];
  if (collected.matched > collected.items.length) lines.push(`(the first ${MAX_COLLECTED} are shown)`);
  lines.push(...cutShort(collected, "These are the matching items among those read."));
  return lines.join("\n");
}

export function describePlan(plan: Plan, view: runbook.View | null = null): string {
  const text = planText(plan);
  const lines = [`GOAL: ${plan.goal}`, "PLAN:", ...(text.length ? text : ["(goal only)"]).map((line) => `  ${line}`)];
  if (plan.values.length) lines.push(`VALUES: ${plan.values.map((value) => value.label).join(", ")}`);
  if (plan.files?.length) lines.push(`FILES: ${plan.files.map((file) => file.label).join(", ")}`);
  for (const key of ["focus", "skip", "read"] as const) {
    if (view?.[key]?.length) lines.push(`${key.toUpperCase()}: ${view[key].join(", ")}`);
  }
  if (plan.compare) lines.push(`COMPARE: ${plan.compare}`);
  if (plan.collect) lines.push(`COLLECT: ${plan.collect}`);
  if (plan.more) lines.push(`MORE: ${plan.more}`);
  if (plan.flow) lines.push(`FLOW: ${plan.flow}`);
  return lines.join("\n");
}

// biome-ignore lint/suspicious/noExplicitAny: the session state.
export function recentActions(state: Record<string, any>): string {
  const rows = (state.history as HistoryEntry[]).filter((h) => h.attempt === state.plan.attempt).slice(-RECENT);
  const downloaded = (files: { name: string; bytes: number }[]): string =>
    files.map((f) => `${f.name} (${f.bytes} bytes)`).join(", ");
  const lines = rows.map(
    (h) =>
      `  ${h.step}. ${h.kind !== "human" ? h.operation : "HUMAN"} ${quote(h.action)}` +
      (h.text ? ` text=${quote(h.text)}` : "") +
      (h.page_changed ? "" : " (page unchanged)") +
      (h.downloads?.length ? ` DOWNLOADED: ${downloaded(h.downloads)}` : ""),
  );
  return `ACTIONS THIS ATTEMPT:\n${lines.length ? lines.join("\n") : "  (none)"}`;
}
