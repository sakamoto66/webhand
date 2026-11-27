/**
 * Saved checks: acceptance criteria written down before they run, so a regression repeats the same expectations.
 * They live in services/<service>/checks/ of the project's .webhand and of the user's ~/.webhand (a project file wins). Webhand reads
 * them and never rewrites them: a failing run does not change what a check expects.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Expectation, parseExpectation } from "../check/index.ts";
import { CheckFileError } from "../core/errors.ts";
import { quote } from "../core/format.ts";
import { isDir, isFile } from "../core/fs.ts";
import type { Scope } from "../core/workspace.ts";
import {
  CHECKS_DIR,
  extractPlaceholders,
  findScopedFile,
  PARAM,
  readTomlFile,
  SERVICES_DIR,
  STATUSES,
  scopedFolders,
  type TomlDoc,
  WORD,
} from "./toml.ts";

const NAME = new RegExp(`^${WORD}/${WORD}$`, "u");
const ENVS = new Set(["test", "read-only"]);

export interface SavedCheck {
  id: string;
  title: string;
  given: string;
  steps: string[];
  stop: string;
  /** `webhand check --expect` strings, with {param} placeholders. */
  expect: string[];
  /** Expectations Claude judges by reading; reported as manual. */
  manual: string[];
  depends_on: string[];
}

export interface CheckFile {
  /** service/name */
  name: string;
  scope: Scope;
  status: "draft" | "approved";
  env: "test" | "read-only";
  start_url: string;
  runbook: string | null;
  params: Record<string, string>;
  checks: SavedCheck[];
  digest: string;
}

function strings(file: string, where: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new CheckFileError(`${file}: ${where} must be a list of non-empty strings`);
  }
  return value;
}

function parseSavedCheck(file: string, item: TomlDoc): SavedCheck {
  const id = item.id;
  if (typeof id !== "string" || !id) throw new CheckFileError(`${file}: a check has no id`);
  const steps = strings(file, `${id}.steps`, item.steps);
  const expect = strings(file, `${id}.expect`, item.expect);
  const manual = strings(file, `${id}.manual`, item.manual);
  if (!steps.length) throw new CheckFileError(`${file}: ${id} has no steps`);
  if (!expect.length && !manual.length) throw new CheckFileError(`${file}: ${id} expects nothing`);
  for (const line of expect) {
    try {
      parseExpectation(line.replace(PARAM, "0"));
    } catch (error) {
      // A placeholder can sit where a number or true/false belongs; only the kind and shape are checked here.
      if (!extractPlaceholders(line).length) throw new CheckFileError(`${file}: ${id}: ${(error as Error).message}`);
    }
  }
  return {
    id,
    title: String(item.title ?? ""),
    given: String(item.given ?? ""),
    steps,
    stop: String(item.stop ?? ""),
    expect,
    manual,
    depends_on: strings(file, `${id}.depends_on`, item.depends_on),
  };
}

function validateReferences(
  file: string,
  startUrl: string,
  params: Record<string, string>,
  checks: SavedCheck[],
): void {
  const ids = new Set(checks.map((check) => check.id));
  if (ids.size !== checks.length) throw new CheckFileError(`${file}: check ids must be unique`);
  for (const check of checks) {
    for (const dependency of check.depends_on) {
      if (!ids.has(dependency)) {
        throw new CheckFileError(`${file}: ${check.id} depends on unknown ${quote(dependency)}`);
      }
    }
  }
  const used = new Set([
    ...extractPlaceholders(startUrl),
    ...checks.flatMap((c) => [...c.steps, ...c.expect, ...c.manual].flatMap(extractPlaceholders)),
  ]);
  for (const key of used) {
    if (!(key in params)) throw new CheckFileError(`${file}: {${key}} is used but not declared under [params]`);
  }
}

/** Reads and validates one check file. `name` is service/name. */
function read(file: string, name: string, scope: Scope): CheckFile {
  const { data, digest } = readTomlFile(file, (msg) => new CheckFileError(msg));
  const [service, stem] = name.split("/");
  if (data.service !== service || data.name !== stem) {
    throw new CheckFileError(`${file}: service and name must be ${quote(service)} and ${quote(stem)}`);
  }
  if (!STATUSES.has(data.status)) throw new CheckFileError(`${file}: status must be draft or approved`);
  if (!ENVS.has(data.env)) throw new CheckFileError(`${file}: env must be test or read-only`);
  if (typeof data.start_url !== "string" || !data.start_url) throw new CheckFileError(`${file}: start_url is required`);
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries((data.params ?? {}) as TomlDoc)) {
    params[key] = String(value?.description ?? "");
  }
  if (!Array.isArray(data.checks) || data.checks.length === 0) throw new CheckFileError(`${file}: no [[checks]]`);
  const checks = (data.checks as TomlDoc[]).map((item) => parseSavedCheck(file, item));
  validateReferences(file, data.start_url, params, checks);
  return {
    name,
    scope,
    status: data.status,
    env: data.env,
    start_url: data.start_url,
    runbook: typeof data.runbook === "string" ? data.runbook : null,
    params,
    checks,
    digest,
  };
}

/** The check file for service/name: the project's if it has one, else the user's. */
export function load(name: string): CheckFile {
  if (!NAME.test(name)) throw new CheckFileError(`Invalid check name: ${quote(name)} (expected service/name)`);
  const [service, stem] = name.split("/");
  const found = findScopedFile(SERVICES_DIR, join(service, CHECKS_DIR, `${stem}.toml`));
  if (!found) throw new CheckFileError(`No saved check ${quote(name)}`);
  return read(found.file, name, found.scope);
}

export interface Listed {
  name: string;
  file: CheckFile | null;
  /** Why the file cannot be used, when it cannot. */
  error: string | null;
}

/** Every saved check of both scopes. A broken file is listed with its error, never skipped. */
export function catalog(): Listed[] {
  const names = new Set<string>();
  for (const { dir } of scopedFolders(SERVICES_DIR)) {
    if (!existsSync(dir)) continue;
    for (const service of readdirSync(dir)) {
      const folder = join(dir, service, CHECKS_DIR);
      if (!isDir(folder)) continue;
      for (const entry of readdirSync(folder)) {
        if (entry.endsWith(".toml") && isFile(join(folder, entry))) names.add(`${service}/${entry.slice(0, -5)}`);
      }
    }
  }
  return [...names].sort().map((name) => {
    try {
      return { name, file: load(name), error: null };
    } catch (error) {
      if (error instanceof CheckFileError) return { name, file: null, error: error.message };
      throw error;
    }
  });
}

/** Fills {param} in a text. Every placeholder must have a value. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(PARAM, (_, key: string) => {
    if (!(key in values)) throw new CheckFileError(`No value for {${key}}: pass --param ${key}=VALUE`);
    return values[key];
  });
}

export function expectations(check: SavedCheck, values: Record<string, string>): Expectation[] {
  return check.expect.map((line) => parseExpectation(fill(line, values)));
}
