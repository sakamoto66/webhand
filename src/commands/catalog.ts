import type { Args } from "../args.ts";
import { quote, show } from "../core/format.ts";
import * as workspace from "../core/workspace.ts";
import { listProfiles } from "../engines/chrome.ts";
import * as checkfile from "../storage/checkfile.ts";
import * as runbook from "../storage/runbook/index.ts";
import * as session from "../storage/session.ts";
import { OK, print } from "./context.ts";
import { chromeOption } from "./options.ts";
import { chooseChrome } from "./shared.ts";
import type { CommandDef } from "./types.ts";

function printService(entry: runbook.CatalogEntry): void {
  const info = entry.info;
  print(`SERVICE ${entry.service}${info ? ` (${info.scope})` : ""}`);
  if (info) {
    print(`  ${info.description}\n  base_url: ${info.base_url}`);
    if (info.allowed_domains?.length) print(`  allowed_domains: ${info.allowed_domains.join(", ")}`);
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

function printCheckEntry(entry: checkfile.Listed): void {
  if (!entry.file) {
    print(`CHECKS ${entry.name} UNUSABLE: ${entry.error}`);
    return;
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

/** All known services and runbooks, for the agent to plan from. */
async function commandCatalog(args: Args): Promise<number> {
  const project = workspace.projectRoot();
  const projectRunbooks = runbook.root("project");
  print(`RUNBOOKS (project) ${projectRunbooks}${project ? "" : " (not created)"}`);
  print(`RUNBOOKS (user) ${runbook.root("user")}`);
  const services = runbook.catalog();
  if (!services.length) print("NO SAVED SERVICES YET. Plan from the request, or teach a service with /webhand-teach");
  for (const entry of services) printService(entry);
  for (const entry of checkfile.catalog()) printCheckEntry(entry);
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

export const catalogCommand: CommandDef = {
  name: "catalog",
  spec: () => ({
    help: "List known services, runbooks, and saved profiles",
    options: [chromeOption()],
  }),
  run: commandCatalog,
};
