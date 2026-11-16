/**
 * What webhand learns about a site from its own runs (v2, stage 3), kept in the user's folder:
 * $WEBHAND_HOME/knowledge/<host>.json. For each kind of page (the address with ids and query values taken out),
 * the operations tried on it (kind and label) and what each did: how often the page changed, and where it went.
 * Only labels of controls that read as plain names are kept; typed text, values, query values, and anything that
 * looks like personal data never are. Nothing here is shown to Jev yet: this step only records.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export class Knowledge {
  private readonly dir: string;

  constructor(dir: string = join(home(), "knowledge")) {
    this.dir = dir;
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
  record(step: { from: unknown; to: unknown; kind: string; label: unknown; changed: boolean }): boolean {
    if (!RECORDED_KINDS.has(step.kind)) return false;
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
}
