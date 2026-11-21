import type { Args } from "../args.ts";
import * as checkfile from "../checkfile.ts";
import { listProfiles } from "../engines/chrome.ts";
import { quote, show } from "../format.ts";
import * as runbook from "../runbook.ts";
import * as session from "../session.ts";
import * as workspace from "../workspace.ts";

import { CliExit, OK, print } from "./context.ts";
import { chooseChrome } from "./start.ts";

/** Everything learned, for Claude to plan from. */
export async function commandCatalog(args: Args): Promise<number> {
  const project = workspace.projectRoot();
  const projectRunbooks = runbook.root("project");
  print(`RUNBOOKS (project) ${projectRunbooks}${project ? "" : " (not created)"}`);
  print(`RUNBOOKS (user) ${runbook.root("user")}`);
  let services: runbook.CatalogEntry[];
  try {
    services = runbook.catalog();
  } catch (error) {
    if (error instanceof runbook.RunbookError) throw new CliExit(error.message);
    throw error;
  }
  if (!services.length) print("NOTHING LEARNED. Plan from the request, or teach a service with /webhand-learn");
  for (const entry of services) {
    const info = entry.info;
    print(`SERVICE ${entry.service}${info ? ` (${info.scope})` : ""}`);
    if (info) {
      print(`  ${info.description}\n  base_url: ${info.base_url}`);
      const login = info.login;
      print(`  login: ${login.required ? "required" : "not required"}${login.url ? ` (${login.url})` : ""}`);
      for (const page of info.pages) {
        print(`  page: ${page.url} — ${page.purpose}`);
        for (const region of page.regions) {
          const fallback = region.default ? ` [${region.default}]` : "";
          print(`    region ${region.key}${fallback}: ${region.purpose}`);
        }
      }
      for (const fact of info.facts) print(`  fact: ${fact}`);
    } else {
      print("  (no service.toml)");
    }
    for (const procedure of entry.procedures) {
      print(`  PROCEDURE ${procedure.name} [${show(procedure.status)}] (${procedure.scope}): ${show(procedure.goal)}`);
      print(`    start_url: ${show(procedure.start_url)}`);
      for (const [key, description] of Object.entries(procedure.params)) print(`    param ${key}: ${description}`);
      if (procedure.human_steps) print(`    human steps: ${procedure.human_steps} (needs --headed)`);
      for (const key of ["focus", "skip"] as const) {
        if (procedure[key]?.length) print(`    ${key}: ${procedure[key].join(", ")}`);
      }
    }
  }
  for (const entry of checkfile.catalog()) {
    if (!entry.file) {
      print(`CHECKS ${entry.name} UNUSABLE: ${entry.error}`);
      continue;
    }
    const file = entry.file;
    print(`CHECKS ${file.name} [${file.status}] env=${file.env} (${file.scope}) digest ${file.digest}`);
    print(`  start_url: ${file.start_url}${file.runbook ? `  runbook: ${file.runbook}` : ""}`);
    for (const [key, description] of Object.entries(file.params)) print(`  param ${key}: ${description}`);
    for (const check of file.checks) {
      const needs = check.depends_on.length ? ` after ${check.depends_on.join(",")}` : "";
      print(`  ${check.id}${needs}: ${check.title} (${check.expect.length} expect, ${check.manual.length} manual)`);
      if (check.given) print(`    given: ${check.given}`);
      for (const step of check.steps) print(`    step: ${step}`);
      if (check.stop) print(`    stop: ${check.stop}`);
    }
  }
  const [chrome, note] = chooseChrome(args.chrome);
  const profiles = listProfiles(chrome);
  print(`CHROME: ${chrome}${note ? ` (${note})` : ""}`);
  print(`SAVED PROFILES: ${profiles.length ? profiles.join(", ") : "(none)"}`);
  const open = session.active();
  if (open.length) {
    print("ACTIVE SESSIONS (use --id on every command of one):");
    for (const [id, state] of open) print(`  ${id}: ${quote(String(state.plan?.goal ?? "").slice(0, 80))}`);
  }
  return OK;
}
