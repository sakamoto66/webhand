/** Dataset loading and filtering for WebArena-Verified, always stripping eval/expected fields. */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderTaskUrl, type WebArenaConfig } from "./config.ts";
import { normalizeSiteKey, WebArenaError } from "./sites.ts";

const DEFAULT_DATASET_PATH = "state/webarena/webarena-verified.json";

/** Public task metadata safe to hand to the planning agent. Never contains `eval` or `expected`. */
export interface WebArenaTaskPublic {
  task_id: number;
  sites: string[];
  start_urls: string[];
  intent: string;
  intent_template_id?: number;
}

interface ListTasksOptions {
  sites?: string[];
  onePerTemplate?: boolean;
  pendingOutDir?: string | null;
  limit?: number | null;
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

function readRawDataset(datasetPath: string): Record<string, unknown>[] {
  let rawTasks: unknown;
  try {
    rawTasks = JSON.parse(readFileSync(datasetPath, "utf8"));
  } catch (error) {
    throw new WebArenaError(`Failed to read WebArena dataset (${datasetPath}): ${(error as Error).message}`);
  }
  if (!Array.isArray(rawTasks)) {
    throw new WebArenaError(`WebArena dataset must be a JSON array: ${datasetPath}`);
  }
  return rawTasks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function toPublicTask(found: Record<string, unknown>, config: WebArenaConfig): WebArenaTaskPublic {
  const taskId = Number(found.task_id);
  const sites = Array.isArray(found.sites) ? found.sites.map((s) => normalizeSiteKey(String(s))) : [];
  const rawUrls = Array.isArray(found.start_urls)
    ? found.start_urls.map(String)
    : typeof found.start_url === "string"
      ? [found.start_url]
      : [];
  const start_urls = rawUrls.map((u) => renderTaskUrl(u, config));
  if (!start_urls.length) throw new WebArenaError(`Task ${taskId} has no start_urls`);
  const intent = String(found.intent ?? "").trim();
  if (!intent) throw new WebArenaError(`Task ${taskId} has an empty intent`);
  return {
    task_id: taskId,
    sites,
    start_urls,
    intent,
    ...(typeof found.intent_template_id === "number" ? { intent_template_id: found.intent_template_id } : {}),
  };
}

/** Loads one task by task_id, stripping `eval` and all expected answer fields so verification stays independent. */
export function loadTaskPublic(datasetPath: string, taskId: number, config: WebArenaConfig): WebArenaTaskPublic {
  const found = readRawDataset(datasetPath).find((item) => item.task_id === taskId);
  if (!found) throw new WebArenaError(`Task ID ${taskId} was not found in ${datasetPath}`);
  return toPublicTask(found, config);
}

/** Lists public task metadata (never exposing `eval` or `expected`), with optional site/template/pending filters. */
export function listTasksPublic(
  datasetPath: string,
  config: WebArenaConfig,
  options: ListTasksOptions = {},
): { totalInDataset: number; tasks: WebArenaTaskPublic[] } {
  const raw = readRawDataset(datasetPath);
  const siteFilter = options.sites?.length ? new Set(options.sites.map(normalizeSiteKey)) : null;
  const pendingOutDir = options.pendingOutDir ? resolve(options.pendingOutDir) : null;

  let tasks = raw
    .filter((item) => typeof item.task_id === "number")
    .map((item) => toPublicTask(item, config))
    .sort((a, b) => a.task_id - b.task_id);

  if (siteFilter) {
    tasks = tasks.filter((task) => task.sites.length > 0 && task.sites.every((site) => siteFilter.has(site)));
  }

  if (options.onePerTemplate) {
    const seenTemplates = new Set<number>();
    tasks = tasks.filter((task) => {
      if (task.intent_template_id === undefined) return true;
      if (seenTemplates.has(task.intent_template_id)) return false;
      seenTemplates.add(task.intent_template_id);
      return true;
    });
  }

  if (pendingOutDir) {
    tasks = tasks.filter(
      (task) => !existsSync(join(pendingOutDir, String(task.task_id), config.agent_response_file_name)),
    );
  }

  if (options.limit !== undefined && options.limit !== null) {
    tasks = tasks.slice(0, options.limit);
  }

  return { totalInDataset: raw.length, tasks };
}
