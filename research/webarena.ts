/**
 * Research CLI wrapper for running ServiceNow/webarena-verified tasks with webhand.
 * Not shipped in npm: run from the repository root as `node research/webarena.ts COMMAND ...`.
 *
 * - `info --task-id ID` prints public task metadata without leaking `eval` / `expected`.
 * - `start --task-id ID [--out-dir DIR]` resolves start URLs, pre-authenticates configured sites
 *   via local Auto-Login headers BEFORE HAR recording starts (so credentials never enter HAR or CLI),
 *   and passes `--har <out-dir>/<id>/network.har` to webhand.
 * - `finish --status ... --task-type ... --wa-status ... [--retrieved-data JSON] [--error-details TEXT] [--eval]`
 *   flushes network.har, writes agent_response.json, and optionally runs `uvx webarena-verified eval-tasks`.
 * - `eval --output-dir DIR [--task-ids ...] [--sites ...] [--config ...]` runs batch offline evaluation.
 * - Every other command (`run`, `answer`, `replan`, `act`, `observe`, `check`, `extract`, ...) passes through.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { UsageError } from "../src/args.ts";
import { type IO, main } from "../src/cli.ts";
import { CliExit, type Hooks, OK } from "../src/commands/context.ts";
import { stamp } from "../src/format.ts";
import * as session from "../src/session.ts";
import {
  type AutoLoginTarget,
  loadConfig,
  loadTaskPublic,
  resolveAutoLoginTargets,
  resolveDatasetPath,
  validateAgentResponse,
  WebArenaError,
} from "./webarena-config.ts";

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

const processIO: IO = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

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
  if (raw === null || !/^\d+$/.test(raw.trim())) {
    throw new UsageError("--task-id must be a non-negative integer");
  }
  return Number.parseInt(raw.trim(), 10);
}

/**
 * Visits each configured Auto-Login site in Chrome BEFORE HAR recording begins so the site's
 * session cookies are stored in Chrome's cookie jar while the Auto-Login header itself never
 * appears in network.har or CLI arguments.
 */
async function preAuthenticate(chromeState: session.State, targets: AutoLoginTarget[]): Promise<void> {
  if (!targets.length || !chromeState.port) return;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chromeState.port}`);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    for (const target of targets) {
      const page = await context.newPage();
      try {
        await page.setExtraHTTPHeaders({ [target.header.name]: target.header.value });
        await page.goto(target.url, { waitUntil: "domcontentloaded" });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Runs `uvx webarena-verified eval-tasks` and prints the score clearly separated from tasks/'s verify(). */
function runEvalTasks(
  options: { outputDir: string; taskIds?: string | null; sites?: string | null; configPath?: string | null },
  io: IO,
): number {
  const cliArgs = ["webarena-verified", "eval-tasks", "--output-dir", resolve(options.outputDir)];
  if (options.taskIds) cliArgs.push("--task-ids", options.taskIds);
  if (options.sites) cliArgs.push("--sites", options.sites);
  if (options.configPath) cliArgs.push("--config", resolve(options.configPath));
  try {
    const out = execFileSync("uvx", cliArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (out.trim()) io.out(`${out.trimEnd()}\n`);
    return OK;
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

async function commandStart(args: string[], io: IO): Promise<number> {
  const { values, rest } = takeOptions(args, ["task-id", "out-dir", "dataset", "config"]);
  if (values["task-id"] === null) return main(["start", ...args], io);
  if (rest.some((arg) => /^--(goal|url|har)(=|$)/.test(arg))) {
    throw new CliExit("WebArena task supplies its own goal, start URL, and HAR path. Drop --goal, --url, and --har");
  }
  const taskId = parseTaskId(values["task-id"]);
  const { config, path: configPath } = loadConfig(values.config);
  const datasetPath = resolveDatasetPath(config, values.dataset);
  const task = loadTaskPublic(datasetPath, taskId, config);
  const outDir = resolve(values["out-dir"] ?? config.output_dir ?? join("runs", "webarena", stamp()));
  const taskDir = join(outDir, String(taskId));
  mkdirSync(taskDir, { recursive: true });
  const harPath = join(taskDir, config.trace_file_name);
  const autoLoginTargets = resolveAutoLoginTargets(config, task.sites);

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
    meta: { webarena: meta },
    ...(autoLoginTargets.length
      ? { beforeStart: async (chromeState) => await preAuthenticate(chromeState, autoLoginTargets) }
      : {}),
  };

  const prevLog = process.env.WEBHAND_LOG;
  if (!prevLog) process.env.WEBHAND_LOG = join(taskDir, "webhand.jsonl");
  try {
    const code = await main(
      ["start", "--goal", task.intent, "--url", task.start_urls[0], "--har", harPath, ...rest],
      io,
      hooks,
    );
    if (code === OK) {
      io.out(`WEBARENA_TASK: id=${taskId} sites=${task.sites.join(",") || "none"} dir=${taskDir}\n`);
      if (task.start_urls.length > 1) {
        io.out(`START_URLS: ${task.start_urls.join(" | ")}\n`);
      }
      if (autoLoginTargets.length) {
        io.out(`AUTO_LOGIN: pre-authenticated ${autoLoginTargets.map((t) => t.site).join(", ")} (cookies only; excluded from HAR)\n`);
      }
    }
    return code;
  } finally {
    if (prevLog === undefined) delete process.env.WEBHAND_LOG;
    else process.env.WEBHAND_LOG = prevLog;
  }
}

async function commandFinish(args: string[], io: IO): Promise<number> {
  const { values, flags, rest } = takeOptions(
    args,
    ["task-type", "wa-status", "retrieved-data", "error-details"],
    ["eval"],
  );
  session.use(session.idFrom(rest));
  const state = session.load();
  const meta = state?.meta?.webarena as WebArenaSessionMeta | undefined;

  if (!meta) {
    if (values["task-type"] || values["wa-status"] || values["retrieved-data"] || values["error-details"] || flags.eval) {
      throw new CliExit("Current session was not started with `research/webarena.ts start --task-id`");
    }
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
    runEvalTasks({ outputDir: meta.out_dir, taskIds: String(meta.task_id), configPath: meta.config_path }, io);
    const summary = summarizeEvalResult(join(meta.task_dir, meta.eval_result_file_name));
    if (summary) io.out(`${summary}\n`);
  } else {
    const cfgPart = meta.config_path ? ` --config ${meta.config_path}` : "";
    io.out(
      `EVAL_HINT: node research/webarena.ts eval --output-dir ${meta.out_dir} --task-ids ${meta.task_id}${cfgPart}\n`,
    );
  }
  return OK;
}

async function commandEval(args: string[], io: IO): Promise<number> {
  const { values, rest } = takeOptions(args, ["output-dir", "task-ids", "sites", "config"]);
  if (rest.length) throw new UsageError(`unrecognized arguments: ${rest.join(" ")}`);
  if (!values["output-dir"]) throw new UsageError("--output-dir is required");
  const { path: configPath } = loadConfig(values.config);
  return runEvalTasks(
    { outputDir: values["output-dir"], taskIds: values["task-ids"], sites: values.sites, configPath },
    io,
  );
}

/** Runs one WebArena-Verified research command and returns its exit code. */
export async function run(argv: string[], io: IO = processIO): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (command === "info") return await commandInfo(args, io);
    if (command === "start") return await commandStart(args, io);
    if (command === "finish") return await commandFinish(args, io);
    if (command === "eval") return await commandEval(args, io);
    return await main(argv, io);
  } catch (error) {
    if (error instanceof WebArenaError) throw new CliExit(error.message);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let code: number;
  try {
    code = await run(process.argv.slice(2));
  } catch (error) {
    const known = error instanceof CliExit || error instanceof UsageError;
    process.stderr.write(`${known ? error.message : error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    code = error instanceof UsageError ? 2 : 1;
  }
  process.exit(code);
}
