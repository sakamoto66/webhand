/** Append-only run logs and token cost. Every line is written at once so a crashed run keeps its data. */

import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { toJson } from "./format.ts";
import type { ModelCall } from "./types.ts";

interface Totals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

/** Token totals per provider. */
export function summarize(calls: ModelCall[]): { providers: Record<string, Totals> } {
  const providers: Record<string, Totals> = {};
  for (const call of calls) {
    providers[call.provider] ??= { calls: 0, input_tokens: 0, output_tokens: 0 };
    const total = providers[call.provider];
    total.calls += 1;
    total.input_tokens += call.input_tokens || 0;
    total.output_tokens += call.output_tokens || 0;
  }
  return { providers };
}

export function gitState(): { commit: string | null; dirty: boolean } {
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      return null;
    }
  };
  return { commit: git("rev-parse", "HEAD"), dirty: Boolean(git("status", "--porcelain")) };
}

export class Recorder {
  readonly path: string;
  readonly calls: ModelCall[] = [];
  private fd: number | null;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.fd = openSync(path, "a");
  }

  event(type: string, fields: Record<string, unknown> = {}): void {
    if (this.fd === null) throw new Error(`Recorder for ${this.path} is closed`);
    writeSync(this.fd, `${toJson({ type, ...fields })}\n`);
  }

  /** Saves a PNG beside the log as <log>-screenshots/step-NNNN.png and logs which step it follows. */
  screenshot(step: number, attempt: number, png: Buffer, url: unknown): void {
    const name = basename(this.path, ".jsonl");
    const file = join(`${name}-screenshots`, `step-${String(step).padStart(4, "0")}.png`);
    mkdirSync(join(dirname(this.path), `${name}-screenshots`), { recursive: true });
    writeFileSync(join(dirname(this.path), file), png);
    this.event("screenshot", { step, attempt, file, url: safeUrl(url) });
  }

  call(call: ModelCall): void {
    this.calls.push(call);
    this.event("call", { ...call });
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

/** Opens a log, writes one event, and closes it. */
export function logOnce(path: string, type: string, fields: Record<string, unknown> = {}): void {
  const recorder = new Recorder(path);
  try {
    recorder.event(type, fields);
  } finally {
    recorder.close();
  }
}

/** A URL for the run log: query values and a hash that holds values are hidden, as in a learn record. */
export function safeUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, "<redacted>");
    if (parsed.hash.includes("=")) parsed.hash = "<redacted>";
    return parsed.href;
  } catch {
    return null;
  }
}

const OUTLINE_FIELDS = [
  "key",
  "position",
  "text_chars",
  "shown_chars",
  "actions",
  "shown_actions",
  "offscreen_actions",
  "view",
];

/** An observed page for the run log: where it was and its region outline. No page text. */
// biome-ignore lint/suspicious/noExplicitAny: pages come from the page script as untyped JSON.
export function pageEvent(page: Record<string, any>, attempt: number): Record<string, unknown> {
  const regions = Array.isArray(page.regions) ? page.regions : [];
  return {
    attempt,
    url: safeUrl(page.url),
    regions: regions.map((region: Record<string, unknown>) => {
      const kept: Record<string, unknown> = {};
      for (const key of OUTLINE_FIELDS) if (key in region) kept[key] = region[key];
      return kept;
    }),
    omitted_regions: page.omitted_regions ?? 0,
  };
}
