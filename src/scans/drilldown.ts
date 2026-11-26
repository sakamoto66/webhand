/**
 * Read-only list-to-detail drilldown: collect list rows + detail links, filter matching rows in parallel via Jev,
 * pick each row's detail link, visit it via GET navigation, extract structured fields, and return to the list URL.
 * Jev only judges which observed link opens the row's item, which observed field name is each word of --fields, and
 * which blocks of a page are about a field it lacks; the decision and every copied value are code's.
 */

import { ITEMS } from "../browser/scripts/items.ts";
import type { Recorder } from "../core/metrics.ts";
import type { ModelCall, Page, Plan } from "../core/types.ts";
import { hostAllowed } from "../explore.ts";
import type { Driver } from "../ipc/remote.ts";
import type { Collector } from "./collect.ts";
import { type LoadMore, MAX_PAGES } from "./list-scanner.ts";

const BATCH = 40;
export const DEFAULT_MAX_ITEMS = 20;
export const HARD_MAX_ITEMS = 100;
/** A Noul at or above this is yes, at or below NOUL_NO is no, and between them unsure. */
const NOUL_YES = 0.7;
const NOUL_NO = 0.3;
const LINK_NAME_CHARS = 80;
const MAX_LABELS = 60;
const LABEL_CHARS = 80;
const SNIPPET_CHARS = 1500;

interface RowLink {
  href: string;
  name: string;
  /** Where the link sits in its row, such as "td:2>a:1". */
  at: string;
}

interface ListRow {
  row: string;
  /** The tags and classes around the row, to tell one list from another. */
  list: string;
  /** A link taken as a row of its own because the page has no rows: there is nothing to choose. */
  bare: boolean;
  links: RowLink[];
}

/** A row's link as Jev is shown it: no query value, and no folder of a local file. */
export interface LinkView {
  key: string;
  name: string;
  path: string;
}

export interface LinkChooser {
  calls: ModelCall[];
  /** The link that best opens the row's item, and the probability that one of the links does. */
  detailLink(row: string, links: LinkView[]): Promise<{ key: string; noul: number }>;
}

/** A field name observed on a detail page, as Jev is shown it. Its value stays here. */
export interface LabelView {
  key: string;
  label: string;
}

/** The field name that best fits one word of --fields, and the probability that one of the names does. */
export interface FieldMatch {
  key: string;
  noul: number;
}

export interface FieldJudge {
  calls: ModelCall[];
  matchFields(wanted: string[], labels: LabelView[]): Promise<Map<string, FieldMatch>>;
  selectBlocks(page: Page, plan: Plan, query: string, blocks: { key: string; text: string }[]): Promise<Set<string>>;
}

interface Detail {
  url: string;
  title: string;
  fields: Record<string, string>;
  snippet?: string;
  /** The page's main text, read only with --fields. */
  text?: string;
}

/** What --fields found on one page. Without --fields, only fields and perhaps the start of the page. */
interface FieldResult {
  fields: Record<string, string>;
  /** The page's field name taken for each word of --fields. */
  field_labels?: Record<string, string>;
  /** Words of --fields that no field name of the page fits. */
  missing_fields?: string[];
  /** Words for which Jev could not tell whether the field name fits. */
  uncertain_fields?: { field: string; label: string; value: string }[];
  /** With --fields, the blocks of the page about the missing and uncertain words; otherwise its start. */
  snippet?: string;
}

interface DrilldownItem extends FieldResult {
  row: string;
  url: string;
  title: string;
  /** Jev could not tell whether the row has a detail link, so its first link was visited. */
  link_uncertain?: true;
}

export interface DrilldownResult {
  list_url: string;
  match: string | null;
  seen: number;
  matched: number;
  visited: number;
  truncated: boolean;
  /** Matched rows left out because none of their links opens the item. */
  skipped_no_link?: number;
  pages?: number;
  items: DrilldownItem[];
}

interface DrilldownOptions {
  match?: string | null;
  linkText?: string | null;
  linkChooser?: LinkChooser | null;
  fields?: string[] | null;
  fieldJudge?: FieldJudge | null;
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
  const fn = (wanted: string | null, items: Element[]) => {
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
    const eligible = (el: Element) => !skipChrome(el) && isVisible(el) && !el.querySelector("table");
    const isHeader = (el: Element) =>
      Boolean(el.closest("thead")) ||
      Boolean(el.querySelector("th,[role='columnheader']") && !el.querySelector("td,[role='cell'],[role='gridcell']"));
    const usableLinks = (root: Element) =>
      [...root.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((a) => {
        if (!isVisible(a) || skipChrome(a)) return false;
        const raw = a.getAttribute("href") ?? "";
        if (!raw || raw.startsWith("#") || raw.toLowerCase().startsWith("javascript:")) return false;
        if (!wantedLow) return true;
        const txt = norm(a.textContent || a.getAttribute("aria-label") || a.getAttribute("title") || "");
        return txt.toLowerCase().includes(wantedLow);
      });
    // Repeated items (as compare and collect read them) come first, so that cards built of divs are rows. The fixed
    // selectors add the rows of lists too short to repeat, where they do not overlap one of those items.
    const repeated = items.filter((el) => eligible(el) && usableLinks(el).length > 0);
    const listed = [...document.querySelectorAll(rowSelectors)].filter(
      (el) => eligible(el) && !isHeader(el) && !repeated.some((item) => item.contains(el) || el.contains(item)),
    );
    const containers = [...repeated, ...listed].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    const nameOf = (a: Element) =>
      norm(
        a.textContent ||
          a.getAttribute("aria-label") ||
          a.getAttribute("title") ||
          a.querySelector("img[alt]")?.getAttribute("alt") ||
          "",
      );
    const position = (el: Element, root: Element) => {
      const path: string[] = [];
      for (let e: Element | null = el; e && e !== root; e = e.parentElement) {
        let n = 1;
        for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) n += 1;
        path.unshift(`${e.tagName.toLowerCase()}:${n}`);
      }
      return path.join(">");
    };
    const listOf = (row: Element) =>
      [row.parentElement?.parentElement, row.parentElement, row]
        .map((e, i) => (e ? `${e.tagName}.${i < 2 ? (e.getAttribute("class") ?? "") : ""}` : ""))
        .join(">");
    const results: { row: string; list: string; bare: boolean; links: { href: string; name: string; at: string }[] }[] =
      [];
    for (const root of containers) {
      const links = usableLinks(root)
        .filter((a) => a.href)
        .map((a) => ({ href: a.href, name: nameOf(a), at: position(a, root) }));
      const row = norm(root.textContent || "").slice(0, 320);
      if (row && links.length) results.push({ row, list: listOf(root), bare: false, links });
    }
    if (!results.length) {
      for (const a of usableLinks(document.documentElement)) {
        if (!a.href) continue;
        const name = nameOf(a);
        results.push({ row: name || a.href, list: "", bare: true, links: [{ href: a.href, name, at: "" }] });
      }
    }
    return results;
  };
  return `(${fn.toString()})(${JSON.stringify(linkText)}, ${ITEMS}())`;
}

/** The address of a link without its query or fragment. A local file's folders are left out. */
function shownPath(href: string, listUrl: string): string {
  const url = new URL(href, listUrl);
  if (url.protocol === "file:") return url.pathname.split("/").at(-1) ?? "";
  return url.host === new URL(listUrl).host ? url.pathname : `//${url.host}${url.pathname}`;
}

/** Rows of one shape have links at the same places that lead to the same folders, so one answer serves them all. */
function rowShape(row: ListRow): string {
  const folder = (href: string) => {
    const url = new URL(href);
    const folders = url.pathname.split("/").slice(0, -1);
    return `${url.protocol}//${url.host}${folders.map((part) => (/\d/.test(part) ? "#" : part)).join("/")}`;
  };
  return JSON.stringify([row.list, row.links.map((link) => [link.at, folder(link.href)])]);
}

type LinkVerdict = { sure: "yes" | "no" | "unsure"; index: number };

/**
 * Picks the link to visit for each row, or null for a row without a detail link. --link-text is the user's own choice;
 * otherwise Jev is asked once per row shape, and the other rows of that shape take the link at the same place.
 */
function linkPicker(
  chooser: LinkChooser | null,
  linkText: string | null,
  listUrl: string,
  recorder: Recorder,
  attempt: number,
) {
  const verdicts = new Map<string, LinkVerdict>();
  return async (row: ListRow): Promise<{ href: string; uncertain: boolean } | null> => {
    if (row.bare || linkText) return { href: row.links[0].href, uncertain: false };
    const shape = rowShape(row);
    let verdict = verdicts.get(shape);
    if (!verdict) {
      if (!chooser) throw new Error("A Jev chooser is required to pick drilldown links without --link-text");
      const views = row.links.map((link, i) => ({
        key: String(i + 1),
        name: link.name.slice(0, LINK_NAME_CHARS),
        path: shownPath(link.href, listUrl),
      }));
      const answer = await chooser.detailLink(row.row, views);
      for (const call of chooser.calls) recorder.call(call);
      chooser.calls.length = 0;
      const sure = answer.noul >= NOUL_YES ? "yes" : answer.noul <= NOUL_NO ? "no" : "unsure";
      verdict = { sure, index: views.findIndex((view) => view.key === answer.key) };
      verdicts.set(shape, verdict);
      recorder.event("drilldown_link", { attempt, links: views.length, choice: answer.key, noul: answer.noul, sure });
    }
    if (verdict.sure === "no") return null;
    if (verdict.sure === "unsure") return { href: row.links[0].href, uncertain: true };
    return { href: row.links[verdict.index].href, uncertain: false };
  };
}

function detailExtractExpression(withText: boolean): string {
  const fn = (wanted: boolean) => {
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

    // 3. With --fields, also names and values built of divs: two short cells side by side, repeated under one parent.
    if (wanted) {
      const CELLS = new Set(["DIV", "SPAN", "P", "B", "STRONG", "EM"]);
      const isCell = (el: Element) =>
        CELLS.has(el.tagName) &&
        el.children.length < 2 &&
        !el.querySelector("div,p,ul,ol,table,input,select,textarea,button") &&
        isVisible(el) &&
        Boolean(norm(el.textContent || ""));
      const isPair = (el: Element) => {
        const [name, value] = el.children;
        return (
          el.children.length === 2 &&
          !el.closest("nav,header,footer,[role='navigation']") &&
          ![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && norm(n.textContent || "")) &&
          isCell(name) &&
          isCell(value) &&
          norm(name.textContent || "").length <= 40
        );
      };
      const pairs = [...document.querySelectorAll("div,li")].filter(isPair);
      for (const pair of pairs) {
        if (!pairs.some((other) => other !== pair && other.parentElement === pair.parentElement)) continue;
        const [name, value] = pair.children as unknown as HTMLElement[];
        // biome-ignore lint/performance/useDomNodeTextContent: only rendered text, with its line breaks, is wanted.
        addField(name.innerText, value.innerText);
      }
    }

    const mainRoot =
      document.querySelector<HTMLElement>("main,[role='main'],#anchor-content,.page-content") ?? document.body;
    const page = { url: location.href, title: norm(document.title || ""), fields: rawFields };
    // biome-ignore lint/performance/useDomNodeTextContent: only rendered text, with its line breaks, is wanted.
    if (wanted) return { ...page, text: mainRoot?.innerText ?? "" };
    if (Object.keys(rawFields).length || !mainRoot) return page;
    const clone = mainRoot.cloneNode(true) as Element;
    for (const junk of clone.querySelectorAll("script,style,noscript,template")) junk.remove();
    return { ...page, snippet: norm(clone.textContent || "").slice(0, 500) };
  };
  return `(${fn.toString()})(${withText})`;
}

/**
 * Takes the page's fields that fit the words of --fields. A word that exactly one field name equals, ignoring case, is
 * that field. Jev is asked about the other words, once per set of field names, with the names only; code copies the
 * values. For a word without a sure field it also picks the blocks of the page about it.
 */
function fieldPicker(judge: FieldJudge, wanted: string[], plan: Plan, recorder: Recorder, attempt: number) {
  const answers = new Map<string, Map<string, FieldMatch>>();
  const record = () => {
    for (const call of judge.calls) recorder.call(call);
    judge.calls.length = 0;
  };
  return async (detail: Detail, listPage: Page): Promise<FieldResult> => {
    const all = Object.entries(detail.fields);
    const exact = new Map<string, [string, string]>();
    for (const word of wanted) {
      const equal = all.filter(([label]) => label.toLowerCase() === word.toLowerCase());
      if (equal.length === 1) exact.set(word, equal[0]);
    }
    const asked = wanted.filter((word) => !exact.has(word));
    const observed = all.slice(0, MAX_LABELS);
    const labels = observed.map(([label], i) => ({ key: String(i + 1), label: label.slice(0, LABEL_CHARS) }));
    const signature = JSON.stringify([asked, labels]);
    let matches = answers.get(signature);
    if (!matches && asked.length && labels.length) {
      matches = await judge.matchFields(asked, labels);
      record();
      answers.set(signature, matches);
      recorder.event("drilldown_fields", {
        attempt,
        labels: labels.length,
        matches: asked.map((word) => ({ ...matches?.get(word) })),
      });
    }
    const fields: Record<string, string> = {};
    const found: Record<string, string> = {};
    const missing: string[] = [];
    const uncertain: NonNullable<FieldResult["uncertain_fields"]> = [];
    for (const word of wanted) {
      const equal = exact.get(word);
      if (equal) {
        fields[equal[0]] = equal[1];
        found[word] = equal[0];
        continue;
      }
      const match = matches?.get(word);
      if (!match || match.noul <= NOUL_NO) {
        missing.push(word);
        continue;
      }
      const [label, value] = observed[Number(match.key) - 1];
      if (match.noul >= NOUL_YES) {
        fields[label] = value;
        found[word] = label;
      } else uncertain.push({ field: word, label, value });
    }
    const unsure = [...missing, ...uncertain.map((u) => u.field)];
    let snippet = "";
    const blocks = unsure.length ? textBlocks({ text: detail.text } as Page) : [];
    if (blocks.length) {
      // The question's state holds the plan only, so the list page stands for the page.
      const keys = await judge.selectBlocks(listPage, plan, unsure.join(", "), blocks);
      record();
      snippet = blocks
        .filter((block) => keys.has(block.key))
        .map((block) => block.text)
        .join("\n---\n")
        .slice(0, SNIPPET_CHARS);
    }
    return {
      fields,
      ...(Object.keys(found).length ? { field_labels: found } : {}),
      ...(missing.length ? { missing_fields: missing } : {}),
      ...(uncertain.length ? { uncertain_fields: uncertain } : {}),
      ...(snippet ? { snippet } : {}),
    };
  };
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
  const fields = options.fields?.length ? [...new Set(options.fields)] : null;
  if (fields && !options.fieldJudge) throw new Error("A Jev chooser is required to match drilldown --fields");
  const pickFields = fields ? fieldPicker(options.fieldJudge as FieldJudge, fields, plan, recorder, attempt) : null;

  let page: Page = await browser.observe();
  const listUrl = String(page.url ?? "");
  const seenRows = new Set<string>();
  /** Matched rows whose link is not picked yet. */
  const pending: ListRow[] = [];
  const pick = linkPicker(options.linkChooser ?? null, linkText, listUrl, recorder, attempt);
  const toVisit: { row: string; href: string; uncertain: boolean }[] = [];
  const chosen = new Set<string>();
  let totalSeen = 0;
  let matched = 0;
  let skipped = 0;
  let pages = 0;

  while (true) {
    const raw = (await browser.evaluate(listLinksExpression(linkText))) as ListRow[];
    const fresh: ListRow[] = [];
    for (const found of Array.isArray(raw) ? raw : []) {
      const links = (found?.links ?? []).filter((l) => isAllowedDetailUrl(l.href, listUrl, options.allowedDomains));
      if (!links.length) continue;
      // With --link-text the first link is the one to visit, so it alone tells rows apart.
      const key = JSON.stringify(linkText || found.bare ? links[0].href : links.map((l) => l.href));
      if (seenRows.has(key)) continue;
      seenRows.add(key);
      fresh.push({ ...found, links });
    }
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
          if (!keys.has(String(start + i + 1))) return;
          matched += 1;
          pending.push(candidate);
        });
      }
    } else {
      matched += fresh.length;
      pending.push(...fresh);
    }

    while (pending.length && toVisit.length < maxItems) {
      const row = pending.shift() as ListRow;
      const link = await pick(row);
      if (!link) skipped += 1;
      else if (!chosen.has(link.href)) {
        chosen.add(link.href);
        toVisit.push({ row: row.row, ...link });
      }
    }

    if (!options.loadMore || toVisit.length >= maxItems || pages >= MAX_PAGES) break;
    const loaded = await options.loadMore(page);
    if (!loaded) break;
    pages += 1;
    page = loaded;
  }

  const items: DrilldownItem[] = [];
  if (toVisit.length > 0 && !browser.goto) {
    throw new Error("This browser engine does not support URL navigation for drilldown");
  }
  const navigate = browser.goto?.bind(browser);
  try {
    for (const candidate of toVisit) {
      await navigate?.(candidate.href);
      const extracted = (await browser.evaluate(detailExtractExpression(Boolean(fields)))) as Detail;
      const detail: Detail = { ...extracted, fields: extracted?.fields ?? {} };
      items.push({
        row: candidate.row,
        url: detail.url ?? candidate.href,
        title: detail.title ?? "",
        ...(pickFields
          ? await pickFields(detail, page)
          : { fields: detail.fields, ...(detail.snippet ? { snippet: detail.snippet } : {}) }),
        ...(candidate.uncertain ? { link_uncertain: true as const } : {}),
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
    matched,
    visited: items.length,
    truncated: pending.length > 0,
    ...(skipped ? { skipped_no_link: skipped } : {}),
    ...(options.loadMore ? { pages } : {}),
    items,
  };
  recorder.event("drilldown_end", {
    attempt,
    seen: result.seen,
    matched: result.matched,
    visited: result.visited,
    truncated: result.truncated,
    ...(skipped ? { skipped_no_link: skipped } : {}),
    ...(result.pages !== undefined ? { pages: result.pages } : {}),
  });
  return result;
}

/** Formats drilldown results compactly for Claude in json, table, or markdown. */
export function formatDrilldown(result: DrilldownResult, style: "json" | "table" | "markdown" = "json"): string {
  if (style === "json") return JSON.stringify(result, null, 2);
  const keys = [...new Set(result.items.flatMap((item) => Object.keys(item.fields)))];
  const header = [
    `DRILLDOWN: visited=${result.visited} matched=${result.matched} seen=${result.seen}${result.skipped_no_link ? ` skipped_no_detail_link=${result.skipped_no_link}` : ""}${result.truncated ? " (truncated)" : ""}`,
    ...result.items
      .filter((item) => item.link_uncertain)
      .map((item) => `UNCERTAIN LINK (first link of the row used): ${item.title || item.row.slice(0, 60)}`),
    ...result.items.flatMap((item) => {
      const name = item.title || item.row.slice(0, 60);
      return [
        ...(item.missing_fields ? [`MISSING (${name}): ${item.missing_fields.join(", ")}`] : []),
        ...(item.uncertain_fields ?? []).map((u) => `UNCERTAIN (${name}): ${u.field} may be ${u.label}=${u.value}`),
      ];
    }),
  ];
  if (!result.items.length) return `${header[0]}\n(no matching items)`;
  const lacking = result.items.some((item) => item.snippet && (item.missing_fields || item.uncertain_fields));
  const cols = keys.length ? ["title", ...keys, ...(lacking ? ["snippet"] : [])] : ["title", "snippet"];
  const cell = (item: DrilldownItem, col: string) => {
    if (col === "title") return item.title || item.row.slice(0, 60);
    if (col === "snippet") return (item.snippet ?? "").replace(/\s+/g, " ").slice(0, 120);
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
