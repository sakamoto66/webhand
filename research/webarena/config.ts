/** WebArenaVerifiedConfig loading, URL rendering, Auto-Login resolution, and site inspection. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeSiteKey, SITES, SITES_BY_ID, WebArenaError } from "./sites.ts";

interface EnvironmentEntry {
  urls: string[];
  active_url_idx?: number | null;
  use_header_login?: boolean;
  credentials?: Record<string, string> | null;
  extra?: Record<string, unknown>;
}

/** Compatible with WebArenaVerifiedConfig JSON so one config file works with `webarena-verified eval-tasks`. */
export interface WebArenaConfig {
  test_data_file?: string;
  environments: Record<string, EnvironmentEntry>;
  agent_response_file_name: string;
  trace_file_name: string;
  eval_result_file_name: string;
  /** Optional convenience default for output_dir (ignored by webarena-verified if unused). */
  output_dir?: string;
}

export type AutoLoginTarget =
  | {
      mode: "header";
      site: string;
      url: string;
      header: { name: string; value: string };
    }
  | {
      mode: "form";
      site: string;
      loginUrl: string;
      userSelector: string;
      passwordSelector: string;
      submitSelector: string;
      user: string;
      password: string;
    };

/** Secret-free summary of one configured WebArena site for `doctor` diagnostics. */
interface SiteConfigSummary {
  site: string;
  url: string;
  auth_mode: "header" | "form" | "none" | "invalid";
  auth_error?: string;
}

const DEFAULT_CONFIG_PATH = "state/webarena/config.json";

export function defaultConfig(): WebArenaConfig {
  const environments: Record<string, EnvironmentEntry> = {};
  for (const site of SITES) {
    environments[site.id] = { urls: [site.defaultUrl], active_url_idx: 0, use_header_login: false };
  }
  return {
    environments,
    agent_response_file_name: "agent_response.json",
    trace_file_name: "network.har",
    eval_result_file_name: "eval_result.json",
  };
}

/** Loads WebArenaVerifiedConfig-compatible JSON, merging defaults for any omitted sites or filenames. */
export function loadConfig(explicitPath?: string | null): { config: WebArenaConfig; path: string | null } {
  const candidate = explicitPath ?? process.env.WEBARENA_CONFIG ?? DEFAULT_CONFIG_PATH;
  const resolved = resolve(candidate);
  const base = defaultConfig();
  if (!existsSync(resolved)) {
    if (explicitPath) throw new WebArenaError(`WebArena config not found: ${resolved}`);
    return { config: base, path: null };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new WebArenaError(`Invalid WebArena config JSON (${resolved}): ${(error as Error).message}`);
  }
  const environments: Record<string, EnvironmentEntry> = { ...base.environments };
  if (raw.environments && typeof raw.environments === "object") {
    for (const [key, value] of Object.entries(raw.environments as Record<string, EnvironmentEntry>)) {
      if (!value || !Array.isArray(value.urls) || !value.urls.length) continue;
      environments[normalizeSiteKey(key)] = {
        urls: value.urls,
        active_url_idx: value.active_url_idx ?? 0,
        use_header_login: Boolean(value.use_header_login),
        credentials: value.credentials ?? null,
        extra: value.extra ?? {},
      };
    }
  }
  return {
    path: resolved,
    config: {
      test_data_file: typeof raw.test_data_file === "string" ? raw.test_data_file : undefined,
      environments,
      agent_response_file_name:
        typeof raw.agent_response_file_name === "string" ? raw.agent_response_file_name : base.agent_response_file_name,
      trace_file_name: typeof raw.trace_file_name === "string" ? raw.trace_file_name : base.trace_file_name,
      eval_result_file_name:
        typeof raw.eval_result_file_name === "string" ? raw.eval_result_file_name : base.eval_result_file_name,
      output_dir: typeof raw.output_dir === "string" ? raw.output_dir : undefined,
    },
  };
}

function activeSiteUrl(config: WebArenaConfig, site: string): string {
  const key = normalizeSiteKey(site);
  const env = config.environments[key];
  if (env && env.urls.length > 0) {
    const idx = env.active_url_idx ?? 0;
    const picked = env.urls[idx] ?? env.urls[0];
    if (picked) return picked.replace(/\/+$/, "");
  }
  const fallback = SITES_BY_ID.get(key)?.defaultUrl;
  if (!fallback) throw new WebArenaError(`No URL configured for WebArena site "${site}"`);
  return fallback.replace(/\/+$/, "");
}

/** Replaces site placeholders (__SHOPPING__, __SHOPPING_ADMIN__, ...) with configured base URLs. */
export function renderTaskUrl(templateUrl: string, config: WebArenaConfig): string {
  let rendered = templateUrl;
  for (const site of SITES) {
    if (rendered.includes(site.placeholder)) {
      rendered = rendered.replaceAll(site.placeholder, activeSiteUrl(config, site.id));
    }
  }
  return rendered;
}

function pickUser(credentials: Record<string, string>, fields: string[]): string | undefined {
  return fields.map((field) => credentials[field]).find((v) => typeof v === "string" && v);
}

/** Resolves optional Auto-Login target (header or local test-env form login) from config. Never exposed to CLI or HAR. */
function resolveAutoLoginTarget(config: WebArenaConfig, site: string): AutoLoginTarget | null {
  const key = normalizeSiteKey(site);
  const env = config.environments[key];
  if (!env) return null;
  const url = activeSiteUrl(config, key);
  const custom = env.extra?.auto_login_header as { name?: string; value?: string } | undefined;
  if (custom && typeof custom.name === "string" && typeof custom.value === "string" && custom.name && custom.value) {
    return { mode: "header", site: key, url, header: { name: custom.name, value: custom.value } };
  }
  const siteSpec = SITES_BY_ID.get(key);
  if (env.use_header_login) {
    const spec = siteSpec?.headerLogin;
    if (!spec) {
      throw new WebArenaError(
        `Site "${key}" does not support built-in header Auto-Login in webarena-verified; set use_header_login=false with credentials for automatic form pre-login (or set extra.auto_login_header)`,
      );
    }
    const user = env.credentials ? pickUser(env.credentials, spec.userFields) : undefined;
    const password = env.credentials?.password;
    if (!user || !password) {
      throw new WebArenaError(`Site "${key}" has use_header_login=true but is missing credentials`);
    }
    return { mode: "header", site: key, url, header: { name: spec.header, value: `${user}:${password}` } };
  }
  if (!env.credentials || !siteSpec?.formLogin) return null;
  const form = siteSpec.formLogin;
  const user = pickUser(env.credentials, form.userFields);
  const password = env.credentials.password;
  if (!user || !password) return null;
  return {
    mode: "form",
    site: key,
    loginUrl: `${url}${form.loginPath}`,
    userSelector: form.userSelector,
    passwordSelector: form.passwordSelector,
    submitSelector: form.submitSelector,
    user,
    password,
  };
}

export function resolveAutoLoginTargets(config: WebArenaConfig, sites: string[]): AutoLoginTarget[] {
  const targets: AutoLoginTarget[] = [];
  const seen = new Set<string>();
  for (const rawSite of sites) {
    const key = normalizeSiteKey(rawSite);
    if (seen.has(key)) continue;
    seen.add(key);
    const target = resolveAutoLoginTarget(config, key);
    if (target) targets.push(target);
  }
  return targets;
}

/** Summarizes configured sites and auth modes without ever exposing credentials or header values. */
export function inspectSiteConfigs(config: WebArenaConfig, sites?: string[]): SiteConfigSummary[] {
  const keys = sites?.length ? [...new Set(sites.map(normalizeSiteKey))] : Object.keys(config.environments).sort();
  return keys.map((site) => {
    const url = activeSiteUrl(config, site);
    try {
      const target = resolveAutoLoginTarget(config, site);
      return { site, url, auth_mode: target ? target.mode : "none" };
    } catch (error) {
      return {
        site,
        url,
        auth_mode: "invalid",
        auth_error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
