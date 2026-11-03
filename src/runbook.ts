/**
 * What webhand has learned: service information and reviewed procedures (runbooks).
 *
 * Both guide Claude's plan and Jev's choices. Procedures are never replayed. They live in the project's
 * .webhand/runbooks and the user's ~/.webhand/runbooks; a project file wins over a user file of the same name.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "smol-toml";
import { pyRepr, pyStr, pyTruthy } from "./py.ts";
import { roots, type Scope, scopeRoot } from "./workspace.ts";

const WORD = "[\\p{L}\\p{N}_-]+";
const NAME = new RegExp(`^${WORD}(/${WORD})?$`, "u");
const SERVICE_NAME = new RegExp(`^${WORD}$`, "u");
const PARAM = /\{([A-Za-z_][\p{L}\p{N}_]*)\}/gu;
const ACTORS = new Set(["jev", "human"]);
const STATUSES = new Set(["draft", "approved"]);
const DEFAULTS = new Set(["focus", "skip"]); // A region's default in service.toml. Without one, it is observed as usual.
const SERVICE_FILE = "service"; // runbooks/<service>/service.toml holds the service information.

// biome-ignore lint/suspicious/noExplicitAny: TOML documents are untyped until validated.
type Doc = Record<string, any>;

export interface View {
  focus: string[];
  skip: string[];
}

/** The runbook folder of a scope, whether or not it exists. */
export function root(scope: Scope = "project"): string {
  return join(scopeRoot(scope), "runbooks");
}

/** Runbook folders that exist or may exist, project first. */
function folders(): { scope: Scope; dir: string }[] {
  return roots().map(({ scope, dir }) => ({ scope, dir: join(dir, "runbooks") }));
}

/** The runbook cannot be used as written. */
export class RunbookError extends Error {
  override name = "RunbookError";
}

/** Checks a runbook name such as hotel/filter. */
function checkName(name: string): string {
  if (!NAME.test(name) || name.split("/").at(-1) === SERVICE_FILE) {
    throw new RunbookError(`Invalid runbook name: ${pyRepr(name)}`);
  }
  return name;
}

function checkService(service: string): string {
  if (!SERVICE_NAME.test(service)) throw new RunbookError(`Invalid service name: ${pyRepr(service)}`);
  return service;
}

/** Where a runbook of a scope is written. */
export function path(name: string, scope: Scope = "project"): string {
  return join(root(scope), `${checkName(name)}.toml`);
}

/** Where a service's information of a scope is written. */
export function servicePath(service: string, scope: Scope = "project"): string {
  return join(root(scope), checkService(service), `${SERVICE_FILE}.toml`);
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

interface Found {
  file: string;
  scope: Scope;
  /** The folder that holds the scope's .webhand: relative local start_urls are files under it. */
  base: string;
}

/** The file that is read for a relative name: the project's if it has one, else the user's. */
function find(relative: string): Found | null {
  for (const { scope, dir } of folders()) {
    const file = join(dir, relative);
    if (isFile(file)) return { file, scope, base: dirname(dirname(dir)) };
  }
  return null;
}

function findRunbook(name: string): Found | null {
  return find(`${checkName(name)}.toml`);
}

function findService(service: string): Found | null {
  return find(join(checkService(service), `${SERVICE_FILE}.toml`));
}

function readToml(file: string): { raw: Buffer; data: Doc } {
  const raw = readFileSync(file);
  try {
    return { raw, data: parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Doc };
  } catch (error) {
    throw new RunbookError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const get = (doc: Doc, key: string, fallback: unknown = undefined) => (key in doc ? doc[key] : fallback);

/** Region patterns, such as "main/form:宿泊予約" or "footer". Anything else is an error. */
function patterns(file: string, where: string, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new RunbookError(`${file}: ${where} must be a list of region keys`);
  }
  return value.map((item: string) => item.trim());
}

interface Region {
  key: string;
  purpose: string;
  default: string | null;
}

function regions(file: string, page: Doc): Region[] {
  const found: Region[] = [];
  for (const region of get(page, "regions", []) as Doc[]) {
    const raw = get(region, "key");
    const key = patterns(file, "pages.regions.key", raw !== undefined && raw !== null ? [raw] : null);
    if (!key.length) throw new RunbookError(`${file}: a region on ${get(page, "url", "?")} has no key`);
    const fallback = get(region, "default", null);
    if (fallback !== null && !DEFAULTS.has(fallback)) {
      throw new RunbookError(`${file}: region ${pyRepr(key[0])} has unknown default ${pyRepr(fallback)}`);
    }
    found.push({ key: key[0], purpose: get(region, "purpose", ""), default: fallback });
  }
  return found;
}

/**
 * Combines region choices. A later layer wins: learned defaults, then the runbook, then Claude.
 * Focus patterns keep the later layer's order first, since the first focus is shown first.
 */
export function view(...layers: (Partial<View> | null | undefined)[]): View {
  let focus: string[] = [];
  let skip: string[] = [];
  for (const layer of layers) {
    if (!pyTruthy(layer)) continue;
    const newFocus = [...(layer?.focus ?? [])];
    const newSkip = [...(layer?.skip ?? [])];
    const kept = (p: string) => !newFocus.includes(p) && !newSkip.includes(p);
    focus = [...newFocus, ...focus.filter(kept)];
    skip = [...skip.filter(kept), ...newSkip];
  }
  return { focus, skip };
}

export interface ServiceInfo {
  service: string;
  description: string;
  base_url: string;
  login: { required: boolean; url: string | null };
  pages: { url: string; purpose: string; regions: Region[] }[];
  facts: string[];
  scope: Scope;
}

/** What the service information says to focus on or skip on every page. */
export function serviceView(info: ServiceInfo | null): View {
  const keys = (info?.pages ?? []).flatMap((page) => page.regions);
  return {
    focus: keys.filter((r) => r.default === "focus").map((r) => r.key),
    skip: keys.filter((r) => r.default === "skip").map((r) => r.key),
  };
}

/** Service information for Claude's plan and Jev's state. null when nothing was learned. */
export function loadService(service: string): ServiceInfo | null {
  const found = findService(service);
  if (!found) return null;
  const { file, scope } = found;
  const { data } = readToml(file);
  const missing = ["service", "description", "base_url", "sources"].filter((key) => !pyTruthy(data[key]));
  if (missing.length) throw new RunbookError(`${file}: missing ${missing.join(", ")}`);
  const login = get(data, "login", {});
  return {
    service: data.service,
    description: String(data.description).trim(),
    base_url: data.base_url,
    login: { required: pyTruthy(get(login, "required")), url: get(login, "url", null) },
    pages: (get(data, "pages", []) as Doc[]).map((p) => ({
      url: get(p, "url", ""),
      purpose: get(p, "purpose", ""),
      regions: regions(file, p),
    })),
    facts: (get(data, "facts", []) as unknown[]).map(pyStr),
    scope,
  };
}

interface Procedure {
  name: string;
  scope: Scope;
  status: unknown;
  goal: unknown;
  start_url: unknown;
  params: Record<string, string>;
  human_steps: number;
  focus: string[];
  skip: string[];
}

export interface CatalogEntry {
  service: string;
  info: ServiceInfo | null;
  procedures: Procedure[];
}

function subfolders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Everything learned in both scopes, without filling parameters. Claude reads this to plan. */
export function catalog(): CatalogEntry[] {
  const services = [...new Set(folders().flatMap(({ dir }) => subfolders(dir)))].sort();
  return services.map((service) => {
    const info = loadService(service);
    const names = new Set<string>();
    for (const { dir } of folders()) {
      const folder = join(dir, service);
      if (!existsSync(folder)) continue;
      for (const file of readdirSync(folder)) {
        if (file.endsWith(".toml") && file !== `${SERVICE_FILE}.toml` && isFile(join(folder, file))) {
          names.add(file.slice(0, -".toml".length));
        }
      }
    }
    const procedures = [...names].sort().map((stem): Procedure => {
      const found = find(join(service, `${stem}.toml`));
      if (!found) throw new RunbookError(`${service}/${stem} disappeared while reading`);
      const { data } = readToml(found.file);
      return {
        name: `${service}/${stem}`,
        scope: found.scope,
        status: get(data, "status", null),
        goal: get(data, "goal", null),
        start_url: get(data, "start_url", null),
        params: Object.fromEntries(
          Object.entries(get(data, "params", {}) as Doc).map(([k, v]) => [k, get(v, "description", "")]),
        ),
        human_steps: (get(data, "steps", []) as Doc[]).filter((s) => get(s, "actor") === "human").length,
        focus: get(data, "focus", []),
        skip: get(data, "skip", []),
      };
    });
    return { service, info, procedures };
  });
}

export function parseValues(pairs: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new RunbookError(`Expected KEY=VALUE, got ${pyRepr(pair)}`);
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

/** Validates a runbook and fills in its parameters. Every problem is an error, not a guess. */
export function load(name: string, values: Record<string, string> = {}): Runbook {
  const found = findRunbook(name);
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
  const { raw, data } = readToml(file);
  const required = ["service", "name", "goal", "start_url", "status", "sources", "steps"];
  const missing = required.filter((key) => !pyTruthy(data[key]));
  if (missing.length) throw new RunbookError(`${file}: missing ${missing.join(", ")}`);
  if (!STATUSES.has(data.status)) throw new RunbookError(`${file}: unknown status ${pyRepr(data.status)}`);

  const declared = get(data, "params", {}) as Doc;
  const unknown = Object.keys(values)
    .filter((key) => !(key in declared))
    .sort();
  if (unknown.length) throw new RunbookError(`${file}: unknown parameters ${pyRepr(unknown)}`);
  const filled: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(declared)) filled[key] = key in values ? values[key] : get(spec, "default");

  const fill = (text: string): string =>
    String(text).replace(PARAM, (_match, param: string) => {
      const value = filled[param];
      if (value === null || value === undefined) {
        throw new RunbookError(`${file}: parameter ${pyRepr(param)} has no value. Pass --param ${param}=VALUE`);
      }
      return pyStr(value);
    });

  const steps = (data.steps as Doc[]).map((step, i) => {
    const number = i + 1;
    const actor = get(step, "actor", "jev");
    if (!ACTORS.has(actor)) throw new RunbookError(`${file}: step ${number} has unknown actor ${pyRepr(actor)}`);
    if (!pyTruthy(step.instruction)) throw new RunbookError(`${file}: step ${number} has no instruction`);
    return {
      actor,
      instruction: fill(step.instruction),
      hints: (get(step, "hints", []) as string[]).map(fill),
      done_when: pyTruthy(step.done_when) ? fill(step.done_when) : null,
    };
  });
  return {
    name,
    scope,
    service: data.service,
    status: data.status,
    digest: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    goal: fill(data.goal),
    start_url: resolveUrl(fill(data.start_url), base),
    steps,
    focus: patterns(file, "focus", get(data, "focus")),
    skip: patterns(file, "skip", get(data, "skip")),
  };
}
