/**
 * Read-only list-to-detail drilldown: collect list rows + detail links, filter matching rows in parallel via Jev,
 * visit each matched detail URL via GET navigation, extract structured fields, and return to the list URL.
 */

import type { Recorder } from "../core/metrics.ts";
import type { Page, Plan } from "../core/types.ts";
import { hostAllowed } from "../explore.ts";
import type { Driver } from "../ipc/remote.ts";
import type { Collector } from "./collect.ts";
import { type LoadMore, MAX_PAGES } from "./list-scanner.ts";

const BATCH = 40;
export const DEFAULT_MAX_ITEMS = 20;
export const HARD_MAX_ITEMS = 100;

interface ListLinkCandidate {
  row: string;
  href: string;
  linkText: string;
}

interface DrilldownItem {
  row: string;
  url: string;
  title: string;
  fields: Record<string, string>;
  snippet?: string;
}

export interface DrilldownResult {
  list_url: string;
  match: string | null;
  seen: number;
  matched: number;
  visited: number;
  truncated: boolean;
  pages?: number;
  items: DrilldownItem[];
}

interface DrilldownOptions {
  match?: string | null;
  linkText?: string | null;
  fields?: string[] | null;
  maxItems?: number;
  allowedDomains?: string[] | null;
  loadMore?: LoadMore | null;
  attempt?: number;
}

/** Validates that a detail href stays within the same origin (or configured allowed_domains) and safe schemes. */
export function isAllowedDetailUrl(href: string, listUrl: string, allowedDomains?: string[] | null): boolean {
  let target: URL;
  let base: URL;
  try {
    base = new URL(listUrl);
    target = new URL(href, base);
  } catch {
    return false;
  }
  if (!["http:", "https:", "file:"].includes(target.protocol)) return false;
  if (target.protocol !== base.protocol) return false;
  if (allowedDomains?.length) return hostAllowed(target.href, allowedDomains);
  if (target.protocol === "file:") return true;
  return target.origin === base.origin;
}

function listLinksExpression(linkText: string | null): string {
  const fn = (wanted: string | null) => {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const wantedLow = wanted ? wanted.toLowerCase() : null;
    const isVisible = (el: Element): boolean => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const skipChrome = (el: Element) => Boolean(el.closest("nav,header,footer,[role='navigation']"));
    const rowSelectors = "tbody tr, table tr, [role='row'], main li, article";
    const containers = [...document.querySelectorAll(rowSelectors)].filter(
      (el) => !skipChrome(el) && isVisible(el) && !el.querySelector("table"),
    );
    const seen = new Set<string>();
    const results: { row: string; href: string; linkText: string }[] = [];
    const pickLinks = (root: Element) => {
      const links = [...root.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((a) => {
        if (!isVisible(a) || skipChrome(a)) return false;
        const raw = a.getAttribute("href") ?? "";
        if (!raw || raw.startsWith("#") || raw.toLowerCase().startsWith("javascript:")) return false;
        if (wantedLow) {
          const txt = norm(
            a.textContent || a.getAttribute("aria-label") || a.getAttribute("title") || "",
          ).toLowerCase();
          return txt.includes(wantedLow);
        }
        return true;
      });
      if (!links.length) return;
      const chosen = links[0];
      const href = chosen.href;
      if (!href || seen.has(href)) return;
      seen.add(href);
      const row = norm(root.textContent || "").slice(0, 320);
      const text = norm(chosen.textContent || chosen.getAttribute("aria-label") || chosen.getAttribute("title") || "");
      if (row) results.push({ row, href, linkText: text });
    };
    for (const container of containers) pickLinks(container);
    if (!results.length) {
      for (const a of [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]) {
        if (skipChrome(a) || !isVisible(a)) continue;
        const raw = a.getAttribute("href") ?? "";
        if (!raw || raw.startsWith("#") || raw.toLowerCase().startsWith("javascript:")) continue;
        const text = norm(a.textContent || a.getAttribute("aria-label") || a.getAttribute("title") || "");
        if (wantedLow && !text.toLowerCase().includes(wantedLow)) continue;
        if (!a.href || seen.has(a.href)) continue;
        seen.add(a.href);
        results.push({ row: text || a.href, href: a.href, linkText: text });
      }
    }
    return results;
  };
  return `(${fn.toString()})(${JSON.stringify(linkText)})`;
}

function detailExtractExpression(wantedFields: string[] | null): string {
  const fn = (wanted: string[] | null) => {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const isVisible = (el: Element): boolean => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textWithoutControls = (label: Element): string => {
      const clone = label.cloneNode(true) as Element;
      for (const ctrl of clone.querySelectorAll("input,select,textarea")) ctrl.remove();
      return norm(clone.textContent || "");
    };
    const labelFor = (el: HTMLElement): string => {
      const aria = el.getAttribute("aria-label");
      if (aria) return norm(aria);
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return norm(lbl.textContent || "");
      }
      const parentLabel = el.closest("label");
      if (parentLabel) {
        const t = textWithoutControls(parentLabel);
        if (t) return t;
      }
      const field = el.closest(".field,.admin__field,tr,fieldset");
      const head = field?.querySelector("label,legend,th");
      if (head && !head.contains(el)) {
        const t = norm(head.textContent || "");
        if (t) return t;
      }
      return norm(el.getAttribute("placeholder") || el.getAttribute("name") || "");
    };

    const rawFields: Record<string, string> = {};
    // The element or name that each checkbox field was named after, to tell its other boxes from a namesake field.
    const boxFields = new Map<string, Element | string>();
    const addField = (key: string, value: string, boxField?: Element | string) => {
      const k = norm(key)
        .replace(/[:*]+$/, "")
        .trim();
      const v = norm(value);
      if (!k || !v) return;
      if (!(k in rawFields)) {
        rawFields[k] = v;
        if (boxField !== undefined) boxFields.set(k, boxField);
      } else if (boxField !== undefined && boxFields.get(k) === boxField) {
        rawFields[k] += `, ${v}`;
      }
    };

    // 1. Form inputs (never password, hidden, or file).
    for (const el of [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select"),
    ]) {
      if (el instanceof HTMLInputElement) {
        const type = (el.type || "text").toLowerCase();
        if (["password", "hidden", "file", "submit", "button", "reset", "image"].includes(type)) continue;
        if (type === "radio" || type === "checkbox") {
          if (!el.checked) continue;
          const fieldContainer = el.closest(".admin__field,.field,tr");
          const fieldHead = fieldContainer?.querySelector(":scope > label, :scope > .admin__field-label, label, th");
          // A label that wraps a radio or checkbox names that option, not the field. So does one that points to
          // an option with label[for] when the field has several.
          const options = 'input[type="radio"],input[type="checkbox"]';
          const headNamesOption =
            fieldHead?.matches(`label:has(${options})`) ||
            (fieldHead instanceof HTMLLabelElement &&
              Boolean(fieldHead.control?.matches(options)) &&
              (fieldContainer?.querySelectorAll(options).length ?? 0) > 1);
          const head = fieldHead && !headNamesOption && !fieldHead.contains(el) ? fieldHead : null;
          const legend = el.closest("fieldset")?.querySelector("legend");
          const groupSource = head?.textContent ? head : legend?.textContent ? legend : el.name || "Choice";
          const groupText = typeof groupSource === "string" ? groupSource : groupSource.textContent;
          const groupLabel = norm(groupText || "") || "Choice";
          const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
          const wrapper = [...(el.labels ?? [])].find((l) => l !== forLabel && l.contains(el));
          const labels = [forLabel, wrapper].filter((l) => l != null);
          const elAttr = norm(el.getAttribute("aria-label") || el.getAttribute("title") || "");
          // A label with a letter or digit of any script names the option; a symbol-only one (a star) does not.
          const meaningful = (s: string) => /[\p{L}\p{N}]/u.test(s);
          const lblTexts = labels.map(textWithoutControls);
          const lblTitles = labels.map((l) => norm(l.getAttribute("title") || l.getAttribute("aria-label") || ""));
          let groupPos = "";
          if (type === "radio" && el.name) {
            const group = [
              ...document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`),
            ];
            if (group.length > 1) {
              const idx = group.indexOf(el);
              if (idx >= 0) groupPos = `${idx + 1}/${group.length}${el.id ? ` (${el.id})` : ""}`;
            }
          }
          const optLabel =
            lblTexts.find(meaningful) ||
            lblTitles.find(meaningful) ||
            (meaningful(elAttr) ? elAttr : "") ||
            groupPos ||
            norm(el.value || "") ||
            lblTexts.find(Boolean) ||
            "checked";
          addField(groupLabel, optLabel, type === "checkbox" ? groupSource : undefined);
          continue;
        }
        if (!isVisible(el)) continue;
        addField(labelFor(el), el.value);
      } else if (el instanceof HTMLTextAreaElement) {
        if (!isVisible(el)) continue;
        addField(labelFor(el), el.value);
      } else if (el instanceof HTMLSelectElement) {
        if (!isVisible(el)) continue;
        const selected = [...el.selectedOptions].map((o) => norm(o.textContent || o.label || o.value)).filter(Boolean);
        addField(labelFor(el), selected.join(", "));
      }
    }

    // 2. Definition lists and 2-column detail tables.
    for (const dt of [...document.querySelectorAll("dt")]) {
      if (!isVisible(dt)) continue;
      const dd = dt.nextElementSibling;
      if (dd?.tagName === "DD") addField(dt.textContent || "", dd.textContent || "");
    }
    for (const tr of [...document.querySelectorAll("tr")]) {
      if (!isVisible(tr)) continue;
      const th = tr.querySelector(":scope > th");
      const td = tr.querySelector(":scope > td");
      if (th && td && tr.children.length === 2) addField(th.textContent || "", td.textContent || "");
    }

    const wantedLow = wanted?.length ? wanted.map((w) => w.toLowerCase()) : null;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawFields)) {
      if (!wantedLow || wantedLow.some((w) => k.toLowerCase().includes(w))) fields[k] = v;
    }

    const mainRoot = document.querySelector("main,[role='main'],#anchor-content,.page-content") ?? document.body;
    let snippet = "";
    if (mainRoot) {
      const clone = mainRoot.cloneNode(true) as Element;
      for (const junk of clone.querySelectorAll("script,style,noscript,template")) junk.remove();
      snippet = norm(clone.textContent || "").slice(0, 500);
    }
    return {
      url: location.href,
      title: norm(document.title || ""),
      fields,
      ...(Object.keys(fields).length === 0 || (wantedLow && Object.keys(fields).length < wantedLow.length)
        ? { snippet }
        : {}),
    };
  };
  return `(${fn.toString()})(${JSON.stringify(wantedFields)})`;
}

/** Collects candidate links across the current list (and optional --more pages), filters via Jev, and visits detail pages read-only. */
export async function drilldownScan(
  browser: Driver,
  collector: Collector | null,
  plan: Plan,
  options: DrilldownOptions,
  recorder: Recorder,
): Promise<DrilldownResult> {
  const attempt = options.attempt ?? plan.attempt ?? 1;
  const maxItems = Math.max(1, Math.min(HARD_MAX_ITEMS, options.maxItems ?? DEFAULT_MAX_ITEMS));
  const match = options.match?.trim() || null;
  const linkText = options.linkText?.trim() || null;
  const fields = options.fields?.length ? options.fields : null;

  let page: Page = await browser.observe();
  const listUrl = String(page.url ?? "");
  const seenHrefs = new Set<string>();
  const matchedCandidates: ListLinkCandidate[] = [];
  let totalSeen = 0;
  let pages = 0;

  while (true) {
    const raw = (await browser.evaluate(listLinksExpression(linkText))) as ListLinkCandidate[];
    const fresh = (Array.isArray(raw) ? raw : []).filter((c) => {
      if (!c?.href || seenHrefs.has(c.href)) return false;
      if (!isAllowedDetailUrl(c.href, listUrl, options.allowedDomains)) return false;
      seenHrefs.add(c.href);
      return true;
    });
    totalSeen += fresh.length;

    if (match) {
      if (!collector) throw new Error("A Jev chooser is required to filter drilldown rows with --match");
      for (let start = 0; start < fresh.length; start += BATCH) {
        const chunk = fresh.slice(start, start + BATCH);
        const rows = chunk.map((c, i) => ({ key: String(start + i + 1), text: c.row }));
        const keys = await collector.collect(page, plan, match, rows);
        for (const call of collector.calls) recorder.call(call);
        collector.calls.length = 0;
        chunk.forEach((candidate, i) => {
          if (keys.has(String(start + i + 1))) matchedCandidates.push(candidate);
        });
      }
    } else {
      matchedCandidates.push(...fresh);
    }

    if (!options.loadMore || matchedCandidates.length >= maxItems || pages >= MAX_PAGES) break;
    const loaded = await options.loadMore(page);
    if (!loaded) break;
    pages += 1;
    page = loaded;
  }

  const toVisit = matchedCandidates.slice(0, maxItems);
  const items: DrilldownItem[] = [];
  if (toVisit.length > 0 && !browser.goto) {
    throw new Error("This browser engine does not support URL navigation for drilldown");
  }
  const navigate = browser.goto?.bind(browser);
  try {
    for (const candidate of toVisit) {
      await navigate?.(candidate.href);
      const extracted = (await browser.evaluate(detailExtractExpression(fields))) as {
        url: string;
        title: string;
        fields: Record<string, string>;
        snippet?: string;
      };
      items.push({
        row: candidate.row,
        url: extracted?.url ?? candidate.href,
        title: extracted?.title ?? "",
        fields: extracted?.fields ?? {},
        ...(extracted?.snippet ? { snippet: extracted.snippet } : {}),
      });
    }
  } finally {
    if (toVisit.length > 0 && listUrl) {
      await navigate?.(listUrl).catch(() => {});
    }
  }

  const result: DrilldownResult = {
    list_url: listUrl,
    match,
    seen: totalSeen,
    matched: matchedCandidates.length,
    visited: items.length,
    truncated: matchedCandidates.length > toVisit.length,
    ...(options.loadMore ? { pages } : {}),
    items,
  };
  recorder.event("drilldown_end", {
    attempt,
    seen: result.seen,
    matched: result.matched,
    visited: result.visited,
    truncated: result.truncated,
    ...(result.pages !== undefined ? { pages: result.pages } : {}),
  });
  return result;
}

/** Formats drilldown results compactly for Claude in json, table, or markdown. */
export function formatDrilldown(result: DrilldownResult, style: "json" | "table" | "markdown" = "json"): string {
  if (style === "json") return JSON.stringify(result, null, 2);
  const keys = [...new Set(result.items.flatMap((item) => Object.keys(item.fields)))];
  const header = [
    `DRILLDOWN: visited=${result.visited} matched=${result.matched} seen=${result.seen}${result.truncated ? " (truncated)" : ""}`,
  ];
  if (!result.items.length) return `${header[0]}\n(no matching items)`;
  const cols = keys.length ? ["title", ...keys] : ["title", "snippet"];
  const cell = (item: DrilldownItem, col: string) => {
    if (col === "title") return item.title || item.row.slice(0, 60);
    if (col === "snippet") return (item.snippet ?? "").slice(0, 120);
    return item.fields[col] ?? "";
  };
  if (style === "markdown") {
    const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
    return [
      ...header,
      `| ${cols.map(esc).join(" | ")} |`,
      `| ${cols.map(() => "---").join(" | ")} |`,
      ...result.items.map((item) => `| ${cols.map((c) => esc(cell(item, c))).join(" | ")} |`),
    ].join("\n");
  }
  const lines = [...header, cols.join("\t")];
  for (const item of result.items) lines.push(cols.map((c) => cell(item, c).replace(/\t/g, " ")).join("\t"));
  return lines.join("\n");
}

/** Splits page text (and optional read layer) into compact blocks for parallel Jev relevance selection. */
export function textBlocks(page: Page, maxBlocks = 40): { key: string; text: string }[] {
  const sources: string[] = [];
  if (typeof page.text === "string" && page.text.trim()) sources.push(page.text);
  if (typeof page.read?.text === "string" && page.read.text.trim()) sources.push(page.read.text);
  const rawLines = sources
    .join("\n\n")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const blocks: { key: string; text: string }[] = [];
  let buf = "";
  const flush = () => {
    if (!buf) return;
    if (blocks.length < maxBlocks) blocks.push({ key: String(blocks.length + 1), text: buf });
    buf = "";
  };
  for (const line of rawLines) {
    if (buf.length + line.length + 1 > 450 && buf.length >= 120) flush();
    buf = buf ? `${buf}\n${line}` : line;
  }
  flush();
  return blocks;
}
