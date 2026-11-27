/** Subcommand handlers for the WebArena-Verified research wrapper. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { UsageError } from "../../src/args.ts";
import { type IO, main } from "../../src/cli.ts";
import { CliExit, type Hooks, OK } from "../../src/commands/context.ts";
import { stamp } from "../../src/core/format.ts";
import * as workspace from "../../src/core/workspace.ts";
import * as session from "../../src/storage/session.ts";
import { preAuthenticate } from "./auth.ts";
import { inspectSiteConfigs, loadConfig, resolveAutoLoginTargets } from "./config.ts";
import { listTasksPublic, loadTaskPublic, resolveDatasetPath } from "./dataset.ts";
import { formatReportMarkdown, summarizeRunDir } from "./report.ts";
import { validateAgentResponse } from "./response.ts";

interface WebArenaSessionMeta {
  task_id: number;
  out_dir: string;
  task_dir: string;
  sites: string[];
  start_urls: string[];
  config_path: string | null;
  agent_response_file_name: string;
  eval_result_file_name: string;
}

/** Extracts named string options and boolean flags from argv, returning them and the remaining args. */
function takeOptions(
  argv: string[],
  valueNames: string[],
  flagNames: string[] = [],
): { values: Record<string, string | null>; flags: Record<string, boolean>; rest: string[] } {
  const values: Record<string, string | null> = Object.fromEntries(valueNames.map((n) => [n, null]));
  const flags: Record<string, boolean> = Object.fromEntries(flagNames.map((n) => [n, false]));
  const rest: string[] = [];
  const valueSet = new Set(valueNames);
  const flagSet = new Set(flagNames);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
    if (flagSet.has(name)) {
      if (eq >= 0) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    if (valueSet.has(name)) {
      if (eq >= 0) {
        values[name] = token.slice(eq + 1);
      } else {
        const next = argv[++i];
        if (next === undefined) throw new UsageError(`--${name} expects a value`);
        values[name] = next;
      }
      continue;
    }
    rest.push(token);
  }
  return { values, flags, rest };
}

function parseTaskId(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw.trim())) throw new UsageError("--task-id must be a non-negative integer");
  return Number.parseInt(raw.trim(), 10);
}

function parsePositiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw.trim())) throw new UsageError(`${flag} must be a positive integer`);
  const value = Number.parseInt(raw.trim(), 10);
  if (value < 1) throw new UsageError(`${flag} must be a positive integer`);
  return value;
}

function parseSitesList(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function currentGitRev(): string | null {
  try {
    return (
      execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function updateRunMeta(outDir: string, datasetPath: string, sites: string[]): void {
  const metaPath = join(outDir, "run_meta.json");
  const now = new Date().toISOString();
  let existing: { created_at?: string; sites?: string[]; git_rev?: string | null } = {};
  if (existsSync(metaPath)) {
    try {
      existing = JSON.parse(readFileSync(metaPath, "utf8")) as typeof existing;
    } catch {
      existing = {};
    }
  }
  const mergedSites = [...new Set([...(existing.sites ?? []), ...sites])].sort();
  const payload = {
    created_at: existing.created_at ?? now,
    updated_at: now,
    git_rev: existing.git_rev ?? currentGitRev(),
    node_version: process.version,
    dataset_file: basename(datasetPath),
    sites: mergedSites,
  };
  writeFileSync(metaPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function runEvalTasks(
  options: {
    outputDir: string;
    taskIds?: string | null;
    sites?: string | null;
    configPath?: string | null;
    quiet?: boolean;
  },
  io: IO,
): string {
  const cliArgs = ["webarena-verified", "eval-tasks", "--output-dir", resolve(options.outputDir)];
  if (options.taskIds) cliArgs.push("--task-ids", options.taskIds);
  if (options.sites) cliArgs.push("--sites", options.sites);
  if (options.configPath) cliArgs.push("--config", resolve(options.configPath));
  try {
    const out = execFileSync("uvx", cliArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (!options.quiet && out.trim()) io.out(`${out.trimEnd()}\n`);
    return out;
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    if (err.stdout?.trim()) io.out(`${err.stdout.trimEnd()}\n`);
    throw new CliExit(
      `webarena-verified eval-tasks failed: ${(err.stderr || err.message || String(error)).trim().split("\n")[0]}`,
    );
  }
}

function summarizeEvalResult(evalResultPath: string): string | null {
  if (!existsSync(evalResultPath)) return null;
  try {
    const data = JSON.parse(readFileSync(evalResultPath, "utf8")) as {
      score?: number;
      status?: string;
      task_id?: number;
    };
    return `WEBARENA_VERIFIED_SCORE: task_id=${data.task_id ?? "?"} status=${data.status ?? "?"} score=${data.score ?? "?"} (separate from tasks/ verify())`;
  } catch {
    return null;
  }
}

async function probeUrl(url: string, timeoutMs: number): Promise<{ reachable: boolean; detail: string }> {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return { reachable: true, detail: `HTTP ${res.status}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { reachable: false, detail: msg.split("\n")[0] };
  }
}

function statusOption(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--status") return argv[i + 1] ?? null;
    if (argv[i].startsWith("--status=")) return argv[i].slice("--status=".length);
  }
  return null;
}

async function commandInfo(args: string[], io: IO): Promise<number> {
  const { values, rest } = takeOptions(args, ["task-id", "dataset", "config"]);
  if (rest.length) throw new UsageError(`unrecognized arguments: ${rest.join(" ")}`);
  const taskId = parseTaskId(values["task-id"]);
  const { config } = loadConfig(values.config);
  const datasetPath = resolveDatasetPath(config, values.dataset);
  const task = loadTaskPublic(datasetPath, taskId, config);
  io.out(`${JSON.stringify(task, null, 2)}\n`);
  return OK;
}

async function commandList(args: string[], io: IO): Promise<number> {
  const { values, flags, rest } = takeOptions(
    args,
    ["sites", "out-dir", "limit", "dataset", "config"],
    ["one-per-template", "pending", "json"],
  );
  if (rest.length) throw new UsageError(`unrecognized arguments: ${rest.join(" ")}`);
  if (flags.pending && !values["out-dir"]) throw new UsageError("--pending requires --out-dir");
  const limit = values.limit !== null ? parsePositiveInt(values.limit, "--limit") : null;
  const { config } = loadConfig(values.config);
  const datasetPath = resolveDatasetPath(config, values.dataset);
  const { totalInDataset, tasks } = listTasksPublic(datasetPath, config, {
    sites: parseSitesList(values.sites),
    onePerTemplate: flags["one-per-template"],
    pendingOutDir: flags.pending ? values["out-dir"] : null,
    limit,
  });
  if (flags.json) {
    io.out(`${JSON.stringify(tasks, null, 2)}\n`);
    return OK;
  }
  io.out(`TASKS: ${tasks.length} (dataset: ${totalInDataset})\n`);
  io.out(`TASK_IDS: ${tasks.map((t) => t.task_id).join(",")}\n`);
  for (const task of tasks) {
    const tpl = task.intent_template_id !== undefined ? String(task.intent_template_id) : "-";
    const intentSingleLine = task.intent.replace(/\s+/g, " ");
    io.out(`${task.task_id}\t${task.sites.join(",") || "-"}\ttpl=${tpl}\t${task.start_urls[0]}\t${intentSingleLine}\n`);
  }
  return OK;
}

async function commandDoctor(args: string[], io: IO): Promise<number> {
  const { values, rest } = takeOptions(args, ["sites", "dataset", "config", "timeout-ms"]);
  if (rest.length) throw new UsageError(`unrecognized arguments: ${rest.join(" ")}`);
  const timeoutMs = values["timeout-ms"] !== null ? parsePositiveInt(values["timeout-ms"], "--timeout-ms") : 2500;
  const { config, path: configPath } = loadConfig(values.config);
  let ok = true;

  io.out(`CONFIG: ${configPath ?? "(default)"}\n`);

  try {
    const datasetPath = resolveDatasetPath(config, values.dataset);
    const { totalInDataset } = listTasksPublic(datasetPath, config, { limit: 0 });
    io.out(`DATASET: OK (${totalInDataset} tasks at ${datasetPath})\n`);
  } catch (error) {
    ok = false;
    io.out(`DATASET: MISSING (${error instanceof Error ? error.message : String(error)})\n`);
  }

  try {
    const uvxVersion = execFileSync("uvx", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    io.out(`UVX: OK (${uvxVersion})\n`);
  } catch {
    io.out("UVX: MISSING (install uv/uvx to run webarena-verified eval-tasks)\n");
  }

  const freeGiB = freemem() / 1024 ** 3;
  const totalGiB = totalmem() / 1024 ** 3;
  const memHint = freeGiB < 2 ? " (low free RAM: stop unused site containers and run sequentially)" : "";
  io.out(`MEMORY: free=${freeGiB.toFixed(1)}GiB total=${totalGiB.toFixed(1)}GiB${memHint}\n`);

  const siteSummaries = inspectSiteConfigs(config, parseSitesList(values.sites));
  for (const summary of siteSummaries) {
    const probe = await probeUrl(summary.url, timeoutMs);
    if (!probe.reachable || summary.auth_mode === "invalid") ok = false;
    const reachText = probe.reachable ? `reachable (${probe.detail})` : `unreachable (${probe.detail})`;
    const authText = summary.auth_error ? `${summary.auth_mode} (${summary.auth_error})` : summary.auth_mode;
    io.out(`SITE ${summary.site}: url=${summary.url} reach=${reachText} auth=${authText}\n`);
  }

  return ok ? OK : 1;
}

async function commandReport(args: string[], io: IO): Promise<number> {
  const { values, rest } = takeOptions(args, ["output-dir", "out-dir", "format", "config"]);
  if (rest.length) throw new UsageError(`unrecognized arguments: ${rest.join(" ")}`);
  const outputDir = values["output-dir"] ?? values["out-dir"];
  if (!outputDir) throw new UsageError("--output-dir is required");
  const format = (values.format ?? "md").trim().toLowerCase();
  if (format !== "md" && format !== "json") {
    throw new UsageError(`Invalid --format "${values.format}" (expected md or json)`);
  }
  const { config } = loadConfig(values.config);
  const report = summarizeRunDir(outputDir, config);
  io.out(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : formatReportMarkdown(report));
  return OK;
}

async function commandStart(args: string[], io: IO): Promise<number> {
  const { values, rest } = takeOptions(args, ["task-id", "out-dir", "dataset", "config"]);
  if (values["task-id"] === null) return main(["start", ...args], io);
  if (rest.some((arg) => /^--(goal|url|har)(=|$)/.test(arg))) {
    throw new CliExit("WebArena task supplies its own goal, start URL, and HAR path. Drop --goal, --url, and --har");
  }
  session.use(session.idFrom(rest));
  if (session.load()) {
    throw new CliExit("A session is active. Run: finish --status abandoned, or start another with --id");
  }
  const taskId = parseTaskId(values["task-id"]);
  const { config, path: configPath } = loadConfig(values.config);
  const datasetPath = resolveDatasetPath(config, values.dataset);
  const task = loadTaskPublic(datasetPath, taskId, config);
  const outDir = resolve(values["out-dir"] ?? config.output_dir ?? join(workspace.home(), "runs", "webarena", stamp()));
  const taskDir = join(outDir, String(taskId));
  mkdirSync(taskDir, { recursive: true });
  updateRunMeta(outDir, datasetPath, task.sites);
  const harPath = join(taskDir, config.trace_file_name);
  const explicitAuth = rest.some((arg) => /^--auth(=|$)/.test(arg));
  const autoLoginTargets = explicitAuth ? [] : resolveAutoLoginTargets(config, task.sites);

  const meta: WebArenaSessionMeta = {
    task_id: taskId,
    out_dir: outDir,
    task_dir: taskDir,
    sites: task.sites,
    start_urls: task.start_urls,
    config_path: configPath,
    agent_response_file_name: config.agent_response_file_name,
    eval_result_file_name: config.eval_result_file_name,
  };

  const hooks: Hooks = {
    task: `webarena_${taskId}`,
    log: process.env.WEBHAND_LOG || join(taskDir, "webhand.jsonl"),
    meta: { webarena: meta },
    ...(autoLoginTargets.length
      ? { beforeStart: async (chromeState) => await preAuthenticate(chromeState, autoLoginTargets) }
      : {}),
  };

  const code = await main(
    ["start", "--goal", task.intent, "--url", task.start_urls[0], "--har", harPath, ...rest],
    io,
    hooks,
  );
  if (code === OK || session.load()) {
    io.out(`WEBARENA_TASK: id=${taskId} sites=${task.sites.join(",") || "none"} dir=${taskDir}\n`);
    if (task.start_urls.length > 1) io.out(`START_URLS: ${task.start_urls.join(" | ")}\n`);
    if (autoLoginTargets.length) {
      io.out(
        `AUTO_LOGIN: pre-authenticated ${autoLoginTargets.map((t) => `${t.site} (${t.mode})`).join(", ")} (cookies only; excluded from HAR)\n`,
      );
    }
  }
  return code;
}

async function commandFinish(args: string[], io: IO): Promise<number> {
  const { values, flags, rest } = takeOptions(
    args,
    ["task-type", "wa-status", "retrieved-data", "error-details"],
    ["eval", "verbose"],
  );
  session.use(session.idFrom(rest));
  const state = session.load();
  const meta = state?.meta?.webarena as WebArenaSessionMeta | undefined;
  const hasWaOptions = Boolean(
    values["task-type"] ||
      values["wa-status"] ||
      values["retrieved-data"] ||
      values["error-details"] ||
      flags.eval ||
      flags.verbose,
  );

  if (!meta) {
    if (hasWaOptions) {
      throw new CliExit("Current session was not started with `research/webarena.ts start --task-id`");
    }
    return main(["finish", ...rest], io);
  }

  // Allow abandoning an interrupted WebArena session cleanly without requiring a FinalAgentResponse.
  if (statusOption(rest) === "abandoned" && !hasWaOptions) {
    return main(["finish", ...rest], io);
  }

  // Validate agent_response.json BEFORE closing Chrome so a malformed answer never loses the session.
  const response = validateAgentResponse({
    taskType: values["task-type"],
    status: values["wa-status"],
    retrievedDataRaw: values["retrieved-data"],
    errorDetails: values["error-details"],
  });

  const code = await main(["finish", ...rest], io);
  if (code !== OK) return code;

  mkdirSync(meta.task_dir, { recursive: true });
  const responsePath = join(meta.task_dir, meta.agent_response_file_name);
  writeFileSync(responsePath, `${JSON.stringify(response, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  io.out(`AGENT_RESPONSE: ${responsePath}\n`);

  if (flags.eval) {
    const rawEvalOut = runEvalTasks(
      { outputDir: meta.out_dir, taskIds: String(meta.task_id), configPath: meta.config_path, quiet: !flags.verbose },
      io,
    );
    const summary = summarizeEvalResult(join(meta.task_dir, meta.eval_result_file_name));
    if (summary) io.out(`${summary}\n`);
    else if (!flags.verbose && rawEvalOut.trim()) io.out(`${rawEvalOut.trimEnd()}\n`);
  } else {
    const cfgPart = meta.config_path ? ` --config ${meta.config_path}` : "";
    io.out(
      `EVAL_HINT: node research/webarena.ts eval --output-dir ${meta.out_dir} --task-ids ${meta.task_id}${cfgPart}\n`,
    );
  }
  return OK;
}

async function commandEval(args: string[], io: IO): Promise<number> {
  const { values, rest } = takeOptions(args, ["output-dir", "out-dir", "task-ids", "sites", "config"]);
  if (rest.length) throw new UsageError(`unrecognized arguments: ${rest.join(" ")}`);
  const outputDir = values["output-dir"] ?? values["out-dir"];
  if (!outputDir) throw new UsageError("--output-dir is required");
  const { path: configPath } = loadConfig(values.config);
  runEvalTasks({ outputDir, taskIds: values["task-ids"], sites: values.sites, configPath }, io);
  return OK;
}

export const COMMANDS: Record<string, (args: string[], io: IO) => Promise<number>> = {
  info: commandInfo,
  list: commandList,
  doctor: commandDoctor,
  report: commandReport,
  start: commandStart,
  finish: commandFinish,
  eval: commandEval,
};
