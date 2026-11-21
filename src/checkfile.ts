/**
 * Saved checks: acceptance criteria written down before they run, so a regression repeats the same expectations.
 * They live in the project's .webhand/checks and the user's ~/.webhand/checks (a project file wins). Webhand reads
 * them and never rewrites them: a failing run does not change what a check expects.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { type Expectation, parseExpectation } from "./check.ts";
import { quote } from "./format.ts";
import { roots, type Scope } from "./workspace.ts";

const WORD = "[\\p{L}\\p{N}_-]+";
const NAME = new RegExp(`^${WORD}/${WORD}$`, "u");
const PARAM = /\{([A-Za-z_][\p{L}\p{N}_]*)\}/gu;
const STATUSES = new Set(["draft", "approved"]);
const ENVS = new Set(["test", "read-only"]);

export class CheckFileError extends Error {
  override name = "CheckFileError";
}

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

// biome-ignore lint/suspicious/noExplicitAny: TOML documents are untyped until validated.
type Doc = Record<string, any>;

function strings(file: string, where: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new CheckFileError(`${file}: ${where} must be a list of non-empty strings`);
  }
  return value;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(PARAM)].map((match) => match[1]);
}

/** Reads and validates one check file. `relative` is service/name. */
function read(file: string, name: string, scope: Scope): CheckFile {
  const raw = readFileSync(file);
  let data: Doc;
  try {
    data = parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Doc;
  } catch (error) {
    throw new CheckFileError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [service, stem] = name.split("/");
  if (data.service !== service || data.name !== stem) {
    throw new CheckFileError(`${file}: service and name must be ${quote(service)} and ${quote(stem)}`);
  }
  if (!STATUSES.has(data.status)) throw new CheckFileError(`${file}: status must be draft or approved`);
  if (!ENVS.has(data.env)) throw new CheckFileError(`${file}: env must be test or read-only`);
  if (typeof data.start_url !== "string" || !data.start_url) throw new CheckFileError(`${file}: start_url is required`);
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries((data.params ?? {}) as Doc)) params[key] = String(value?.description ?? "");
  if (!Array.isArray(data.checks) || data.checks.length === 0) throw new CheckFileError(`${file}: no [[checks]]`);
  const checks: SavedCheck[] = (data.checks as Doc[]).map((item) => {
    const id = item.id;
    if (typeof id !== "string" || !id) throw new CheckFileError(`${file}: a check has no id`);
    const where = `${id}`;
    const steps = strings(file, `${where}.steps`, item.steps);
    const expect = strings(file, `${where}.expect`, item.expect);
    const manual = strings(file, `${where}.manual`, item.manual);
    if (!steps.length) throw new CheckFileError(`${file}: ${where} has no steps`);
    if (!expect.length && !manual.length) throw new CheckFileError(`${file}: ${where} expects nothing`);
    for (const line of expect) {
      try {
        parseExpectation(line.replace(PARAM, "0"));
      } catch (error) {
        // A placeholder can sit where a number or true/false belongs; only the kind and shape are checked here.
        if (!placeholders(line).length) throw new CheckFileError(`${file}: ${where}: ${(error as Error).message}`);
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
      depends_on: strings(file, `${where}.depends_on`, item.depends_on),
    };
  });
  const ids = new Set(checks.map((check) => check.id));
  if (ids.size !== checks.length) throw new CheckFileError(`${file}: check ids must be unique`);
  for (const check of checks) {
    for (const dependency of check.depends_on) {
      if (!ids.has(dependency))
        throw new CheckFileError(`${file}: ${check.id} depends on unknown ${quote(dependency)}`);
    }
  }
  const used = new Set([
    ...placeholders(data.start_url),
    ...checks.flatMap((c) => [...c.steps, ...c.expect, ...c.manual].flatMap(placeholders)),
  ]);
  for (const key of used) {
    if (!(key in params)) throw new CheckFileError(`${file}: {${key}} is used but not declared under [params]`);
  }
  return {
    name,
    scope,
    status: data.status,
    env: data.env,
    start_url: data.start_url,
    runbook: typeof data.runbook === "string" ? data.runbook : null,
    params,
    checks,
    digest: createHash("sha256").update(raw).digest("hex").slice(0, 16),
  };
}

function folders(): { scope: Scope; dir: string }[] {
  return roots().map(({ scope, dir }) => ({ scope, dir: join(dir, "checks") }));
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The check file for service/name: the project's if it has one, else the user's. */
export function load(name: string): CheckFile {
  if (!NAME.test(name)) throw new CheckFileError(`Invalid check name: ${quote(name)} (expected service/name)`);
  for (const { scope, dir } of folders()) {
    const file = join(dir, `${name}.toml`);
    if (isFile(file)) return read(file, name, scope);
  }
  throw new CheckFileError(`No saved check ${quote(name)}`);
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
  for (const { dir } of folders()) {
    if (!existsSync(dir)) continue;
    for (const service of readdirSync(dir)) {
      const folder = join(dir, service);
      if (!statSync(folder).isDirectory()) continue;
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
