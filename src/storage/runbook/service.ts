/** Service information (runbooks/<service>/service.toml). */

import { join } from "node:path";
import { ExploreError, RunbookError } from "../../core/errors.ts";
import { quote, show } from "../../core/format.ts";
import { type Scope, scopeRoot } from "../../core/workspace.ts";
import { parseHostList } from "../../explore.ts";
import { findScopedFile, getField, isBlank, readTomlFile, type TomlDoc, WORD } from "../toml.ts";
import { patterns, type View } from "./view.ts";

export const RUNBOOK_SUBDIR = "runbooks";
export const SERVICE_FILE = "service"; // runbooks/<service>/service.toml holds the service information.
const SERVICE_NAME = new RegExp(`^${WORD}$`, "u");
const DEFAULTS = new Set(["focus", "skip"]); // A region's default in service.toml. Without one, it is observed as usual.

interface Region {
  key: string;
  purpose: string;
  default: string | null;
}

export interface ServiceInfo {
  service: string;
  description: string;
  base_url: string;
  allowed_domains?: string[];
  login: { required: boolean; url: string | null };
  pages: { url: string; purpose: string; regions: Region[] }[];
  facts: string[];
  scope: Scope;
}

/** The runbook folder of a scope, whether or not it exists. */
export function root(scope: Scope = "project"): string {
  return join(scopeRoot(scope), RUNBOOK_SUBDIR);
}

function checkService(service: string): string {
  if (!SERVICE_NAME.test(service)) throw new RunbookError(`Invalid service name: ${quote(service)}`);
  return service;
}

/** Where a service's information of a scope is written. */
export function servicePath(service: string, scope: Scope = "project"): string {
  return join(root(scope), checkService(service), `${SERVICE_FILE}.toml`);
}

function regions(file: string, page: TomlDoc): Region[] {
  const found: Region[] = [];
  for (const region of getField(page, "regions", []) as TomlDoc[]) {
    const raw = getField(region, "key");
    const key = patterns(file, "pages.regions.key", raw !== undefined && raw !== null ? [raw] : null);
    if (!key.length) throw new RunbookError(`${file}: a region on ${getField(page, "url", "?")} has no key`);
    const fallback = getField(region, "default", null);
    if (fallback !== null && !DEFAULTS.has(fallback)) {
      throw new RunbookError(`${file}: region ${quote(key[0])} has unknown default ${quote(fallback)}`);
    }
    found.push({ key: key[0], purpose: getField(region, "purpose", ""), default: fallback });
  }
  return found;
}

/** What the service information says to focus on or skip on every page. */
export function serviceView(info: ServiceInfo | null): View {
  const keys = (info?.pages ?? []).flatMap((page) => page.regions);
  return {
    focus: keys.filter((r) => r.default === "focus").map((r) => r.key),
    skip: keys.filter((r) => r.default === "skip").map((r) => r.key),
  };
}

function parseServiceDomains(file: string, raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new RunbookError(`${file}: allowed_domains must be an array of hosts`);
  try {
    return parseHostList(
      raw.map((item) => {
        if (typeof item !== "string") throw new RunbookError(`${file}: allowed_domains entries must be strings`);
        return item;
      }),
      `${file}: allowed_domains`,
    );
  } catch (error) {
    if (error instanceof ExploreError) throw new RunbookError(error.message);
    throw error;
  }
}

/** Service information for the agent's plan and Jev's state. null when none is saved. */
export function loadService(service: string): ServiceInfo | null {
  const found = findScopedFile(RUNBOOK_SUBDIR, join(checkService(service), `${SERVICE_FILE}.toml`));
  if (!found) return null;
  const { file, scope } = found;
  const { data } = readTomlFile(file, (msg) => new RunbookError(msg));
  const missing = ["service", "description", "base_url"].filter((key) => isBlank(data[key]));
  if (missing.length) throw new RunbookError(`${file}: missing ${missing.join(", ")}`);
  const login = getField(data, "login", {});
  const allowedDomains = parseServiceDomains(file, getField(data, "allowed_domains"));
  return {
    service: data.service,
    description: String(data.description).trim(),
    base_url: data.base_url,
    ...(allowedDomains.length ? { allowed_domains: allowedDomains } : {}),
    login: { required: !isBlank(getField(login, "required")), url: getField(login, "url", null) },
    pages: (getField(data, "pages", []) as TomlDoc[]).map((p) => ({
      url: getField(p, "url", ""),
      purpose: getField(p, "purpose", ""),
      regions: regions(file, p),
    })),
    facts: (getField(data, "facts", []) as unknown[]).map(show),
    scope,
  };
}
