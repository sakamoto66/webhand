/** Reviewed procedures (runbooks) loading, validation, and parameter expansion. */

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RunbookError } from "../../core/errors.ts";
import { quote, show } from "../../core/format.ts";
import { isFile } from "../../core/fs.ts";
import type { Scope } from "../../core/workspace.ts";
import { findScopedFile, getField, isBlank, PARAM, readTomlFile, STATUSES, type TomlDoc, WORD } from "../toml.ts";
import { RUNBOOK_SUBDIR, root, SERVICE_FILE } from "./service.ts";
import { patterns } from "./view.ts";

const NAME = new RegExp(`^${WORD}(/${WORD})?$`, "u");
const ACTORS = new Set(["jev", "human"]);

export interface Runbook {
  name: string;
  scope: Scope;
  service: string;
  status: string;
  digest: string;
  goal: string;
  start_url: string;
  steps: { actor: string; instruction: string; hints: string[]; done_when: string | null }[];
  focus: string[];
  skip: string[];
}

/** Checks a runbook name such as hotel/filter. */
function checkName(name: string): string {
  if (!NAME.test(name) || name.split("/").at(-1) === SERVICE_FILE) {
    throw new RunbookError(`Invalid runbook name: ${quote(name)}`);
  }
  return name;
}

/** Where a runbook of a scope is written. */
export function path(name: string, scope: Scope = "project"): string {
  return join(root(scope), `${checkName(name)}.toml`);
}

export function parseValues(pairs: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new RunbookError(`Expected KEY=VALUE, got ${quote(pair)}`);
    values[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return values;
}

/** A URL without a scheme is a local file, relative to base (the folder that holds the scope's .webhand). */
export function resolveUrl(url: string, base = process.cwd()): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) return url;
  const hash = url.indexOf("#");
  const withoutFragment = hash >= 0 ? url.slice(0, hash) : url;
  const at = withoutFragment.indexOf("?");
  const local = at >= 0 ? withoutFragment.slice(0, at) : withoutFragment;
  const query = at >= 0 ? withoutFragment.slice(at + 1) : "";
  const file = resolve(base, local);
  if (!isFile(file)) throw new RunbookError(`start_url file not found: ${local}`);
  return pathToFileURL(file).href + (query ? `?${query}` : "");
}

/** Validates a runbook and fills in its parameters. Every problem is an error, not a guess. */
export function load(name: string, values: Record<string, string> = {}): Runbook {
  const found = findScopedFile(RUNBOOK_SUBDIR, `${checkName(name)}.toml`);
  if (!found) throw new RunbookError(`Unknown runbook: ${name}`);
  return loadFile(found.file, name, found.scope, values, found.base);
}

export function loadFile(
  file: string,
  name: string,
  scope: Scope,
  values: Record<string, string> = {},
  base = process.cwd(),
): Runbook {
  const { data, digest } = readTomlFile(file, (msg) => new RunbookError(msg));
  const required = ["service", "name", "goal", "start_url", "status", "steps"];
  const missing = required.filter((key) => isBlank(data[key]));
  if (missing.length) throw new RunbookError(`${file}: missing ${missing.join(", ")}`);
  if (!STATUSES.has(data.status)) throw new RunbookError(`${file}: unknown status ${quote(data.status)}`);

  const declared = getField(data, "params", {}) as TomlDoc;
  const unknown = Object.keys(values)
    .filter((key) => !(key in declared))
    .sort();
  if (unknown.length) throw new RunbookError(`${file}: unknown parameters ${quote(unknown)}`);
  const filled: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(declared)) {
    filled[key] = key in values ? values[key] : getField(spec, "default");
  }

  const fill = (text: string): string =>
    String(text).replace(PARAM, (_match, param: string) => {
      const value = filled[param];
      if (value === null || value === undefined) {
        throw new RunbookError(`${file}: parameter ${quote(param)} has no value. Pass --param ${param}=VALUE`);
      }
      return show(value);
    });

  const steps = (data.steps as TomlDoc[]).map((step, i) => {
    const number = i + 1;
    const actor = getField(step, "actor", "jev");
    if (!ACTORS.has(actor)) throw new RunbookError(`${file}: step ${number} has unknown actor ${quote(actor)}`);
    if (isBlank(step.instruction)) throw new RunbookError(`${file}: step ${number} has no instruction`);
    return {
      actor,
      instruction: fill(step.instruction),
      hints: (getField(step, "hints", []) as string[]).map(fill),
      done_when: isBlank(step.done_when) ? null : fill(step.done_when),
    };
  });
  return {
    name,
    scope,
    service: data.service,
    status: data.status,
    digest,
    goal: fill(data.goal),
    start_url: resolveUrl(fill(data.start_url), base),
    steps,
    focus: patterns(file, "focus", getField(data, "focus")),
    skip: patterns(file, "skip", getField(data, "skip")),
  };
}
