/**
 * Asset loading and startup-time IIFE assembly for assets/snapshot/*.js.
 * No bundler or generated artifact: each module is read once at startup and joined into one self-contained
 * browser expression `(view => { ... })` evaluated in a single CDP Runtime.evaluate call.
 */

import { readFileSync } from "node:fs";

export function asset(name: string): string {
  return readFileSync(new URL(`../../assets/${name}`, import.meta.url), "utf8");
}

const SNAPSHOT_MODULES: [string, string][] = [
  ["constants", "snapshot/constants.js"],
  ["nodes", "snapshot/nodes.js"],
  ["dom", "snapshot/dom.js"],
  ["elements", "snapshot/elements.js"],
  ["freshness", "snapshot/freshness.js"],
  ["regions", "snapshot/regions.js"],
  ["readLayer", "snapshot/read-layer.js"],
  ["actions", "snapshot/actions.js"],
];

function assembleSnapshot(): string {
  const expr = (file: string) => asset(file).trim().replace(/;+$/, "");
  const entries = SNAPSHOT_MODULES.map(([key, file]) => `    ${key}: ${expr(file)},`).join("\n");
  const main = expr("snapshot/main.js");
  return `(view => {\n  if (!document.body) return null;\n  const mods = {\n${entries}\n  };\n  return (${main})(view, mods);\n})`;
}

export const SNAPSHOT = assembleSnapshot();

export interface ViewChoice {
  focus?: string[];
  skip?: string[];
  read?: string[];
  /** v2: offer elements beyond the viewport with their own operations. */
  whole?: boolean;
  /** Scored context mode: include area chunks in the snapshot. */
  areas?: boolean;
}

/** The snapshot expression for a view ({focus, skip} region patterns). The view never changes freshness. */
export function readState(view: ViewChoice | null = null): string {
  return `(${SNAPSHOT})(${JSON.stringify(view ?? {})})`;
}

export const READ_STATE = readState();
export const MARKER = `(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`;
