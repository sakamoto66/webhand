import type { Args } from "../args.ts";
import { quote, show } from "../core/format.ts";
import * as workspace from "../core/workspace.ts";
import { listProfiles } from "../engines/chrome.ts";
import {
  DEFAULT_MIN_SCORE,
  DEFAULT_TOP,
  filterCatalog,
  filterCheckfiles,
  matchCatalog,
} from "../scans/catalog-match.ts";
import * as checkfile from "../storage/checkfile.ts";
import * as runbook from "../storage/runbook/index.ts";
import * as session from "../storage/session.ts";
import { CliExit, deps, OK, print } from "./context.ts";
import { chromeOption } from "./options.ts";
import { chooseChrome } from "./shared.ts";
import type { CommandDef } from "./types.ts";

function printServiceHeader(entry: runbook.CatalogEntry, score?: number): void {
  const info = entry.info;
  const suffix = score !== undefined ? ` [score=${score.toFixed(2)}]` : "";
  print(`SERVICE ${entry.service}${info ? ` (${info.scope})` : ""}${suffix}`);
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
}

function printProcedure(procedure: runbook.CatalogEntry["procedures"][number], score?: number): void {
  const scoreTag = score !== undefined ? ` [score=${score.toFixed(2)}]` : "";
  print(
    `  PROCEDURE ${procedure.name} [${show(procedure.status)}] (${procedure.scope})${scoreTag}: ${show(procedure.goal)}`,
  );
  print(`    start_url: ${show(procedure.start_url)}`);
  for (const [key, description] of Object.entries(procedure.params)) print(`    param ${key}: ${description}`);
  if (procedure.human_steps) print(`    human steps: ${procedure.human_steps} (needs --headed)`);
  for (const key of ["focus", "skip"] as const) {
    if (procedure[key]?.length) print(`    ${key}: ${procedure[key].join(", ")}`);
  }
}

function printService(entry: runbook.CatalogEntry): void {
  printServiceHeader(entry);
  for (const procedure of entry.procedures) printProcedure(procedure);
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

function printFooter(args: Args): void {
  const [chrome, note] = chooseChrome(args.chrome);
  const profiles = listProfiles(chrome);
  print(`CHROME: ${chrome}${note ? ` (${note})` : ""}`);
  print(`SAVED PROFILES: ${profiles.length ? profiles.join(", ") : "(none)"}`);
  const open = session.active();
  if (open.length) {
    print("ACTIVE SESSIONS (use --id on every command of one):");
    for (const [id, state] of open) print(`  ${id}: ${quote(String(state.plan?.goal ?? "").slice(0, 80))}`);
  }
}

/** All known services and runbooks, or a deterministic/Jev-matched subset, for the agent to plan from. */
async function commandCatalog(args: Args): Promise<number> {
  const servicePrefix: string | null = args.service?.trim() || null;
  const runbookName: string | null = args.runbook?.trim() || null;
  const matchQuery: string | null = args.match?.trim() || null;
  const top: number = args.top ?? DEFAULT_TOP;
  const minScore: number = args.min_score ?? DEFAULT_MIN_SCORE;

  if (top < 1) throw new CliExit("--top must be at least 1.");
  if (minScore < 0 || minScore > 1) throw new CliExit("--min-score must be between 0 and 1.");

  const project = workspace.projectRoot();
  const projectServices = runbook.root("project");
  print(`SERVICES (project) ${projectServices}${project ? "" : " (not created)"}`);
  print(`SERVICES (user) ${runbook.root("user")}`);

  const allServices = runbook.catalog();

  if (matchQuery) {
    const scoped = filterCatalog(allServices, { service: servicePrefix });
    if (servicePrefix) {
      print(
        `FILTER service prefix=${quote(servicePrefix)} (${scoped.length} service${scoped.length === 1 ? "" : "s"}: ${scoped.map((s) => s.service).join(", ") || "(none)"})`,
      );
    }
    if (!scoped.length) {
      print("NO MATCHING SERVICES.");
      printFooter(args);
      return OK;
    }
    const policy = deps.policy();
    try {
      const scoreNoul = policy.scoreNoul?.bind(policy);
      if (!scoreNoul) {
        throw new CliExit("The active policy does not support noul scoring for --match.");
      }
      const result = await matchCatalog({ scoreNoul }, scoped, matchQuery, { top, minScore });
      print(
        `MATCH ${quote(matchQuery)} (${result.stages}-stage Jev noul, ${result.calls} call${result.calls === 1 ? "" : "s"}, ${result.evaluatedProcedures}/${result.totalProcedures} procedures)`,
      );
      const below = `(best score < ${minScore.toFixed(2)})`;
      const useFacts = "use the facts of the matched services without a runbook";
      if (!result.procedures.length) {
        print(`NO PROCEDURES IN MATCHED SERVICES${result.factsMatch ? `; ${useFacts}` : ""}.`);
      } else {
        if (!result.strongMatch) {
          print(
            result.factsMatch
              ? `NO STRONG RUNBOOK MATCH ${below}; ${useFacts}.`
              : `NO STRONG MATCH ${below}; plan from scratch or broaden --match.`,
          );
        }
        for (const item of result.procedures) {
          printProcedure(item.procedure, item.score);
        }
      }
      for (const svc of result.services) {
        printServiceHeader(svc.entry, svc.score);
      }
    } finally {
      await policy.close?.();
    }
    printFooter(args);
    return OK;
  }

  if (servicePrefix || runbookName) {
    const filtered = filterCatalog(allServices, { service: servicePrefix, runbook: runbookName });
    const parts: string[] = [];
    if (servicePrefix) parts.push(`service prefix=${quote(servicePrefix)}`);
    if (runbookName) parts.push(`runbook=${quote(runbookName)}`);
    print(
      `FILTER ${parts.join(", ")} (${filtered.length} service${filtered.length === 1 ? "" : "s"}: ${filtered.map((s) => s.service).join(", ") || "(none)"})`,
    );
    if (!filtered.length) {
      print(runbookName ? `NO MATCHING RUNBOOK: ${runbookName}` : `NO MATCHING SERVICES: ${servicePrefix}`);
    }
    for (const entry of filtered) printService(entry);
    for (const entry of filterCheckfiles(checkfile.catalog(), { service: servicePrefix, runbook: runbookName })) {
      printCheckEntry(entry);
    }
    printFooter(args);
    return OK;
  }

  if (!allServices.length)
    print("NO SAVED SERVICES YET. Plan from the request, or teach a service with /webhand-teach");
  for (const entry of allServices) printService(entry);
  for (const entry of checkfile.catalog()) printCheckEntry(entry);
  printFooter(args);
  return OK;
}

export const catalogCommand: CommandDef = {
  name: "catalog",
  spec: () => ({
    help: "List known services, runbooks, and saved profiles",
    options: [
      chromeOption(),
      {
        name: "service",
        type: "string",
        metavar: "PREFIX",
        help: "Filter services by name prefix (deterministic; combinable with --match or --runbook)",
      },
      {
        name: "runbook",
        type: "string",
        metavar: "NAME",
        help: "Show one runbook by exact name (service/name, or name with --service)",
      },
      {
        name: "match",
        type: "string",
        metavar: "QUERY",
        help: "Rank runbooks against a request with Jev noul and show only the top matches",
      },
      {
        name: "top",
        type: "int",
        default: DEFAULT_TOP,
        metavar: "N",
        help: "Maximum number of matched runbooks to show with --match",
      },
      {
        name: "min-score",
        type: "float",
        default: DEFAULT_MIN_SCORE,
        metavar: "F",
        help: "Score threshold below which --match warns that no strong match was found (0 to 1)",
      },
    ],
    conflicts: [["runbook", "match"]],
  }),
  run: commandCatalog,
};
