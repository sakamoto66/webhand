/**
 * Configuration, dataset loading (stripping eval/expected), URL placeholder rendering,
 * Auto-Login header resolution, and FinalAgentResponse validation for ServiceNow/webarena-verified.
 *
 * Research repository only; never shipped in the npm package.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export class WebArenaError extends Error {
  override name = "WebArenaError";
}

const SITE_PLACEHOLDERS: Record<string, string> = {
  shopping: "__SHOPPING__",
  shopping_admin: "__SHOPPING_ADMIN__",
  reddit: "__REDDIT__",
  gitlab: "__GITLAB__",
  wikipedia: "__WIKIPEDIA__",
  map: "__MAP__",
};

const DEFAULT_SITE_URLS: Record<string, string> = {
  shopping: "http://localhost:7770",
  shopping_admin: "http://localhost:7780/admin",
  reddit: "http://localhost:9999",
  gitlab: "http://localhost:8023",
  wikipedia: "http://localhost:8888",
  map: "http://localhost:3030",
};

// webarena-verified 1.2.3 only implements HTTP header Auto-Login for shopping_admin
// (WebArenaVerified.get_custom_auth_header_name). Other sites (shopping, reddit, gitlab) use form pre-login.
const AUTO_LOGIN_HEADERS: Record<string, { header: string; userFields: string[] }> = {
  shopping_admin: { header: "X-M2-Admin-Auto-Login", userFields: ["username", "email"] },
};

interface FormLoginSpec {
  loginPath: string;
  userFields: string[];
  userSelector: string;
  passwordSelector: string;
  submitSelector: string;
}

const FORM_LOGIN_SPECS: Record<string, FormLoginSpec> = {
  shopping: {
    loginPath: "/customer/account/login",
    userFields: ["email", "username"],
    userSelector: 'input#email[name="login[username]"], input[name="login[username]"]',
    passwordSelector: 'input#pass[name="login[password]"], input[name="login[password]"]',
    submitSelector: 'button#send2, form#login-form button[type="submit"]',
  },
  shopping_admin: {
    loginPath: "",
    userFields: ["username", "email"],
    userSelector: 'input#username, input[name="login[username]"]',
    passwordSelector: 'input#login, input[name="login[password]"]',
    submitSelector: 'button.action-login, button[type="submit"]',
  },
  reddit: {
    loginPath: "/login",
    userFields: ["username", "email"],
    userSelector: 'input#login-username, input[name="_username"]',
    passwordSelector: 'input#login-password, input[name="_password"]',
    submitSelector: 'button[type="submit"]',
  },
  gitlab: {
    loginPath: "/users/sign_in",
    userFields: ["username", "email"],
    userSelector: 'input#user_login, input[name="user[login]"]',
    passwordSelector: 'input#user_password, input[name="user[password]"]',
    submitSelector: 'button[type="submit"], input[type="submit"][name="commit"]',
  },
};

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

/** Public task metadata safe to hand to the planning agent. Never contains `eval` or `expected`. */
export interface WebArenaTaskPublic {
  task_id: number;
  sites: string[];
  start_urls: string[];
  intent: string;
  intent_template_id?: number;
}

const TASK_TYPES = ["RETRIEVE", "MUTATE", "NAVIGATE"] as const;
type TaskType = (typeof TASK_TYPES)[number];

const AGENT_STATUSES = [
  "SUCCESS",
  "ACTION_NOT_ALLOWED_ERROR",
  "PERMISSION_DENIED_ERROR",
  "NOT_FOUND_ERROR",
  "DATA_VALIDATION_ERROR",
  "UNKNOWN_ERROR",
] as const;
type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface FinalAgentResponse {
  task_type: TaskType;
  status: AgentStatus;
  retrieved_data?: unknown[];
  error_details?: string;
}

const DEFAULT_CONFIG_PATH = "state/webarena/config.json";
const DEFAULT_DATASET_PATH = "state/webarena/webarena-verified.json";

/** Normalizes keys like "__SHOPPING_ADMIN__" or "SHOPPING_ADMIN" to "shopping_admin". */
function normalizeSiteKey(raw: string): string {
  const cleaned = raw.trim().replace(/^__/, "").replace(/__$/, "").toLowerCase();
  return cleaned;
}

export function defaultConfig(): WebArenaConfig {
  const environments: Record<string, EnvironmentEntry> = {};
  for (const [site, url] of Object.entries(DEFAULT_SITE_URLS)) {
    environments[site] = { urls: [url], active_url_idx: 0, use_header_login: false };
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
  const fallback = DEFAULT_SITE_URLS[key];
  if (!fallback) throw new WebArenaError(`No URL configured for WebArena site "${site}"`);
  return fallback.replace(/\/+$/, "");
}

/** Replaces site placeholders (__SHOPPING__, __SHOPPING_ADMIN__, ...) with configured base URLs. */
export function renderTaskUrl(templateUrl: string, config: WebArenaConfig): string {
  let rendered = templateUrl;
  for (const [site, placeholder] of Object.entries(SITE_PLACEHOLDERS)) {
    if (rendered.includes(placeholder)) {
      rendered = rendered.replaceAll(placeholder, activeSiteUrl(config, site));
    }
  }
  return rendered;
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
  if (env.use_header_login) {
    const spec = AUTO_LOGIN_HEADERS[key];
    if (!spec) {
      throw new WebArenaError(
        `Site "${key}" does not support built-in header Auto-Login in webarena-verified; set use_header_login=false with credentials for automatic form pre-login (or set extra.auto_login_header)`,
      );
    }
    if (!env.credentials) {
      throw new WebArenaError(`Site "${key}" has use_header_login=true but is missing credentials`);
    }
    const user = spec.userFields.map((field) => env.credentials?.[field]).find((v) => typeof v === "string" && v);
    const password = env.credentials.password;
    if (!user || !password) {
      throw new WebArenaError(`Site "${key}" has use_header_login=true but is missing credentials`);
    }
    return { mode: "header", site: key, url, header: { name: spec.header, value: `${user}:${password}` } };
  }
  if (!env.credentials) return null;
  const form = FORM_LOGIN_SPECS[key];
  if (!form) return null;
  const user = form.userFields.map((field) => env.credentials?.[field]).find((v) => typeof v === "string" && v);
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

export function resolveDatasetPath(config: WebArenaConfig, explicitPath?: string | null): string {
  const candidate = explicitPath ?? process.env.WEBARENA_DATASET ?? config.test_data_file ?? DEFAULT_DATASET_PATH;
  const resolved = resolve(candidate);
  if (!existsSync(resolved)) {
    throw new WebArenaError(
      `WebArena dataset not found: ${resolved}. Download it with: uvx webarena-verified dataset-get --output ${DEFAULT_DATASET_PATH}`,
    );
  }
  return resolved;
}

/** Loads one task by task_id, stripping `eval` and all expected answer fields so verification stays independent. */
export function loadTaskPublic(datasetPath: string, taskId: number, config: WebArenaConfig): WebArenaTaskPublic {
  let rawTasks: unknown;
  try {
    rawTasks = JSON.parse(readFileSync(datasetPath, "utf8"));
  } catch (error) {
    throw new WebArenaError(`Failed to read WebArena dataset (${datasetPath}): ${(error as Error).message}`);
  }
  if (!Array.isArray(rawTasks)) {
    throw new WebArenaError(`WebArena dataset must be a JSON array: ${datasetPath}`);
  }
  const found = rawTasks.find(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && (item as Record<string, unknown>).task_id === taskId,
  );
  if (!found) {
    throw new WebArenaError(`Task ID ${taskId} was not found in ${datasetPath}`);
  }
  const sites = Array.isArray(found.sites) ? found.sites.map((s) => normalizeSiteKey(String(s))) : [];
  const rawUrls = Array.isArray(found.start_urls)
    ? found.start_urls.map(String)
    : typeof found.start_url === "string"
      ? [found.start_url]
      : [];
  const start_urls = rawUrls.map((u) => renderTaskUrl(u, config));
  if (!start_urls.length) {
    throw new WebArenaError(`Task ${taskId} has no start_urls`);
  }
  const intent = String(found.intent ?? "").trim();
  if (!intent) {
    throw new WebArenaError(`Task ${taskId} has an empty intent`);
  }
  return {
    task_id: taskId,
    sites,
    start_urls,
    intent,
    ...(typeof found.intent_template_id === "number" ? { intent_template_id: found.intent_template_id } : {}),
  };
}

/** Validates and normalizes a WebArena-Verified FinalAgentResponse object. */
export function validateAgentResponse(input: {
  taskType: string | null;
  status: string | null;
  retrievedDataRaw: string | null;
  errorDetails: string | null;
}): FinalAgentResponse {
  if (!input.taskType) {
    throw new WebArenaError(`--task-type is required (${TASK_TYPES.join(", ")})`);
  }
  const task_type = input.taskType.trim().toUpperCase() as TaskType;
  if (!(TASK_TYPES as readonly string[]).includes(task_type)) {
    throw new WebArenaError(`Invalid --task-type "${input.taskType}" (expected one of: ${TASK_TYPES.join(", ")})`);
  }

  if (!input.status) {
    throw new WebArenaError(`--wa-status is required (${AGENT_STATUSES.join(", ")})`);
  }
  const status = input.status.trim().toUpperCase() as AgentStatus;
  if (!(AGENT_STATUSES as readonly string[]).includes(status)) {
    throw new WebArenaError(`Invalid --wa-status "${input.status}" (expected one of: ${AGENT_STATUSES.join(", ")})`);
  }

  let retrieved_data: unknown[] | null = null;
  if (input.retrievedDataRaw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.retrievedDataRaw);
    } catch (error) {
      throw new WebArenaError(`--retrieved-data must be valid JSON: ${(error as Error).message}`);
    }
    if (parsed !== null && !Array.isArray(parsed)) {
      throw new WebArenaError("--retrieved-data must be a JSON array (or null)");
    }
    retrieved_data = parsed;
  }

  if (task_type === "RETRIEVE") {
    if (status === "SUCCESS" && retrieved_data === null) {
      throw new WebArenaError("--retrieved-data (a JSON array, e.g. '[]') is required for RETRIEVE with SUCCESS");
    }
  } else if (retrieved_data !== null) {
    throw new WebArenaError(`--retrieved-data must be omitted or null for ${task_type} tasks`);
  }

  let error_details = input.errorDetails ? input.errorDetails.trim() : null;
  if (status === "SUCCESS") {
    if (error_details) {
      throw new WebArenaError("--error-details must be omitted when --wa-status is SUCCESS");
    }
    error_details = null;
  }

  // Omit null optional fields: webarena-verified 1.2.3's AgentResponseEvaluator calls .strip() on present error_details.
  return {
    task_type,
    status,
    ...(retrieved_data !== null ? { retrieved_data } : {}),
    ...(error_details !== null ? { error_details } : {}),
  };
}
