/** Append-only run logs and token cost. Every line is written at once so a crashed run keeps its data. */

import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
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
