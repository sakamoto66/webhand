/**
 * What webhand learns about a site from its own runs (v2, stage 3), kept in the user's folder:
 * $WEBHAND_HOME/knowledge/<host>.json. For each kind of page (the address with ids and query values taken out),
 * the operations tried on it (kind and label) and what each did: how often the page changed, and where it went.
 * Only labels of controls that read as plain names are kept, and none from inside a list item (a result, a row,
 * a card: its label is the page's content, such as a name or a title); typed text, values, query values, and anything that
 * looks like personal data never are. Operations from runs that ended done are offered to Jev on the same kind of page (hints()).
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "./workspace.ts";

const MAX_PAGES = 200;
const MAX_TRANSITIONS = 30;
const MAX_LABEL = 60;
const RECORDED_KINDS = new Set(["click", "select"]);

interface Transition {
  kind: string;
  label: string;
  tried: number;
  changed: number;
  /** How many runs that finished as done had this operation among their steps. */
  ok?: number;
  /** Where the page went when it changed: shape of the new address, with how many times. */
  to: Record<string, number>;
}

interface PageKnowledge {
  seen: number;
  transitions: Record<string, Transition>;
}

export interface HostKnowledge {
  host: string;
  pages: Record<string, PageKnowledge>;
}

/** The kind of page an address is: numbers and ids in the path become :n and :id, query values are dropped. */
export function pageShape(url: unknown): { host: string; shape: string } | null {
  if (typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^(https?|file):$/.test(parsed.protocol)) return null;
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (/^\d+$/.test(segment)) return ":n";
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) || /^[0-9a-f]{12,}$/i.test(segment)) return ":id";
      if (segment.length > 40 || (/\d/.test(segment) && /[a-z]/i.test(segment) && segment.length > 16)) return ":x";
      return segment.toLowerCase();
    });
  const keys = [...new Set([...parsed.searchParams.keys()])].sort();
  const host = parsed.protocol === "file:" ? "local" : parsed.host.toLowerCase();
  return { host, shape: `/${segments.join("/")}${keys.length ? `?${keys.join("&")}` : ""}` };
}

/** A control label that is safe to keep: short, plain, with no address, no long number, nothing like a name field. */
export function plainLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const text = label.replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_LABEL) return null;
  if (/@|https?:|\d{5,}/.test(text)) return null;
  return text;
}

const MAX_HINTS = 5;
// Entries in a run's history that are not an operation. After a step, an answer or a NOT_VISIBLE choice means the run was stuck there.
const DEAD_END = new Set(["answer", "missing"]);

export class Knowledge {
  private readonly dir: string;
  private readonly use: boolean;

  /** use: whether hints() offers what is known; recording goes on either way. */
  constructor(dir: string = join(home(), "knowledge"), use = true) {
    this.dir = dir;
    this.use = use;
  }

  private file(host: string): string {
    return join(this.dir, `${host.replace(/[^a-z0-9.-]/g, "_")}.json`);
  }

  load(host: string): HostKnowledge {
    try {
      return JSON.parse(readFileSync(this.file(host), "utf8")) as HostKnowledge;
    } catch {
      return { host, pages: {} };
    }
  }

  /** One executed operation: what was tried on the page at `from`, and whether the page at `to` differs. */
  record(step: {
    from: unknown;
    to: unknown;
    kind: string;
    label: unknown;
    changed: boolean;
    /** The control sits in a list item (a row, a card, a result): its label is content, not a control. */
    inItem?: boolean;
  }): boolean {
    if (!RECORDED_KINDS.has(step.kind) || step.inItem) return false;
    const label = plainLabel(step.label);
    const from = pageShape(step.from);
    if (!label || !from) return false;
    const to = pageShape(step.to);
    const knowledge = this.load(from.host);
    const keys = Object.keys(knowledge.pages);
    if (!knowledge.pages[from.shape] && keys.length >= MAX_PAGES) return false;
    knowledge.pages[from.shape] ??= { seen: 0, transitions: {} };
    const page = knowledge.pages[from.shape];
    page.seen += 1;
    const key = `${step.kind}|${label}`;
    if (!page.transitions[key] && Object.keys(page.transitions).length >= MAX_TRANSITIONS) return false;
    page.transitions[key] ??= { kind: step.kind, label, tried: 0, changed: 0, to: {} };
    const transition = page.transitions[key];
    transition.tried += 1;
    if (step.changed) {
      transition.changed += 1;
      if (to && to.host === from.host && to.shape !== from.shape)
        transition.to[to.shape] = (transition.to[to.shape] ?? 0) + 1;
    }
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(from.host);
    writeFileSync(`${target}.tmp`, JSON.stringify(knowledge, null, 1));
    renameSync(`${target}.tmp`, target);
    return true;
  }

  /**
   * A run finished as done: its click and select steps are marked as the way that worked, except the ones that led
   * nowhere. A step does not count when the run was stuck on the page it led to (the next entry is an answer to
   * Jev's question, or a NOT_VISIBLE choice) or when it changed nothing. `history` is the whole history, so that
   * those entries are there to be seen.
   */
  confirm(history: { kind?: unknown; action?: unknown; url?: unknown; page_changed?: unknown }[]): void {
    const seen = new Set<string>();
    history.forEach((step, i) => {
      const label = plainLabel(step.action);
      const from = pageShape(step.url);
      if (!label || !from || !RECORDED_KINDS.has(String(step.kind)) || step.page_changed === false) return;
      if (DEAD_END.has(String(history[i + 1]?.kind))) return;
      const knowledge = this.load(from.host);
      const transition = knowledge.pages[from.shape]?.transitions[`${step.kind}|${label}`];
      const mark = `${from.host}|${from.shape}|${step.kind}|${label}`;
      if (!transition || seen.has(mark)) return;
      seen.add(mark);
      transition.ok = (transition.ok ?? 0) + 1;
      const target = this.file(from.host);
      writeFileSync(`${target}.tmp`, JSON.stringify(knowledge, null, 1));
      renameSync(`${target}.tmp`, target);
    });
  }

  /** The sites that have knowledge, with how much. */
  hosts(): { host: string; pages: number; operations: number; worked: number }[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return files.sort().map((name) => {
      const knowledge = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as HostKnowledge;
      const transitions = Object.values(knowledge.pages).flatMap((page) => Object.values(page.transitions));
      return {
        host: knowledge.host,
        pages: Object.keys(knowledge.pages).length,
        operations: transitions.length,
        worked: transitions.filter((t) => (t.ok ?? 0) > 0).length,
      };
    });
  }

  /** What is known about a site, as lines a person can read. */
  describe(host: string): string[] {
    const knowledge = this.load(host);
    return Object.entries(knowledge.pages).flatMap(([shape, page]) => [
      `${shape} (seen ${page.seen})`,
      ...Object.values(page.transitions).map((t) => {
        const goes = Object.entries(t.to).sort((a, b) => b[1] - a[1])[0]?.[0];
        return `  ${t.kind.toUpperCase()} "${t.label}": tried ${t.tried}, page changed ${t.changed}, worked ${t.ok ?? 0}${goes ? `, goes to ${goes}` : ""}`;
      }),
    ]);
  }

  /** Forgets a site, or every site when host is null. Returns how many files went. */
  forget(host: string | null): number {
    const names = host === null ? this.hosts().map((h) => h.host) : [host];
    let removed = 0;
    for (const name of names) {
      try {
        rmSync(this.file(name));
        removed += 1;
      } catch {
        // Nothing was known about it.
      }
    }
    return removed;
  }

  /** What worked before on this kind of page: operations of runs that finished as done, the most often first. */
  hints(url: unknown): { operation: string; label: string; worked: string; goes_to?: string }[] {
    const from = pageShape(url);
    if (!this.use || !from) return [];
    const page = this.load(from.host).pages[from.shape];
    if (!page) return [];
    return Object.values(page.transitions)
      .filter((t) => (t.ok ?? 0) > 0)
      .sort((a, b) => (b.ok ?? 0) - (a.ok ?? 0) || b.changed / b.tried - a.changed / a.tried)
      .slice(0, MAX_HINTS)
      .map((t) => {
        const goes = Object.entries(t.to).sort((a, b) => b[1] - a[1])[0]?.[0];
        return {
          operation: t.kind.toUpperCase(),
          label: t.label,
          worked: `${t.ok} of ${t.tried} tries`,
          ...(goes ? { goes_to: goes } : {}),
        };
      });
  }
}
