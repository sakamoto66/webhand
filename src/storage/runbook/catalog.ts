/** Lists all saved services and runbooks across project and user scopes. */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RunbookError } from "../../core/errors.ts";
import { isFile } from "../../core/fs.ts";
import type { Scope } from "../../core/workspace.ts";
import { findScopedFile, getField, readTomlFile, scopedFolders, type TomlDoc } from "../toml.ts";
import { loadService, RUNBOOK_SUBDIR, SERVICE_FILE, type ServiceInfo } from "./service.ts";

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

/** All saved services and runbooks in both scopes, without filling parameters. The agent reads this to plan. */
export function catalog(): CatalogEntry[] {
  const folders = scopedFolders(RUNBOOK_SUBDIR);
  const services = [...new Set(folders.flatMap(({ dir }) => subfolders(dir)))].sort();
  return services.map((service) => {
    const info = loadService(service);
    const names = new Set<string>();
    for (const { dir } of folders) {
      const folder = join(dir, service);
      if (!existsSync(folder)) continue;
      for (const file of readdirSync(folder)) {
        if (file.endsWith(".toml") && file !== `${SERVICE_FILE}.toml` && isFile(join(folder, file))) {
          names.add(file.slice(0, -".toml".length));
        }
      }
    }
    const procedures = [...names].sort().map((stem): Procedure => {
      const found = findScopedFile(RUNBOOK_SUBDIR, join(service, `${stem}.toml`));
      if (!found) throw new RunbookError(`${service}/${stem} disappeared while reading`);
      const { data } = readTomlFile(found.file, (msg) => new RunbookError(msg));
      return {
        name: `${service}/${stem}`,
        scope: found.scope,
        status: getField(data, "status", null),
        goal: getField(data, "goal", null),
        start_url: getField(data, "start_url", null),
        params: Object.fromEntries(
          Object.entries(getField(data, "params", {}) as TomlDoc).map(([k, v]) => [k, getField(v, "description", "")]),
        ),
        human_steps: (getField(data, "steps", []) as TomlDoc[]).filter((s) => getField(s, "actor") === "human").length,
        focus: getField(data, "focus", []),
        skip: getField(data, "skip", []),
      };
    });
    return { service, info, procedures };
  });
}
