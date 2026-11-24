/** Run-directory aggregation and Markdown report formatting for WebArena-Verified runs. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonLines } from "../../src/core/fs.ts";
import type { WebArenaConfig } from "./config.ts";
import { WebArenaError } from "./sites.ts";

interface TaskReportRow {
  task_id: number;
  status: string;
  task_type: string | null;
  wa_status: string | null;
  attempts: number | null;
  score: number | null;
  eval_status: string | null;
  log_path: string | null;
  har_path: string | null;
  agent_response_path: string | null;
}

interface TypeBreakdown {
  total: number;
  evaluated: number;
  success: number;
  failure: number;
  error: number;
}

interface RunDirReport {
  output_dir: string;
  eval_results_path: string | null;
  total: number;
  evaluated: number;
  unevaluated: number;
  success: number;
  failure: number;
  error: number;
  by_task_type: Record<string, TypeBreakdown>;
  tasks: TaskReportRow[];
}

function readWebhandRunEnd(logPath: string): { status: string | null; attempts: number | null } {
  if (!existsSync(logPath)) return { status: null, attempts: null };
  let status: string | null = null;
  let attempts: number | null = null;
  try {
    for (const entry of readJsonLines(readFileSync(logPath, "utf8"))) {
      if (entry.type === "run_end") {
        status = typeof entry.status === "string" ? entry.status : null;
        attempts = typeof entry.attempts === "number" ? entry.attempts : null;
      }
    }
  } catch {
    return { status: null, attempts: null };
  }
  return { status, attempts };
}

function readEvalScoreOnly(evalPath: string): { score: number | null; eval_status: string | null } {
  if (!existsSync(evalPath)) return { score: null, eval_status: null };
  try {
    // Only extract top-level score and status; never expose expected answers, assertions, or failure details.
    const parsed = JSON.parse(readFileSync(evalPath, "utf8")) as { score?: unknown; status?: unknown };
    return {
      score: typeof parsed.score === "number" ? parsed.score : null,
      eval_status: typeof parsed.status === "string" ? parsed.status : null,
    };
  } catch {
    return { score: null, eval_status: null };
  }
}

/** Aggregates all task runs in an output directory (including failed/blocked/incomplete runs) without leaking eval details. */
export function summarizeRunDir(outputDir: string, config: WebArenaConfig): RunDirReport {
  const resolvedDir = resolve(outputDir);
  if (!existsSync(resolvedDir)) {
    throw new WebArenaError(`Output directory not found: ${resolvedDir}`);
  }
  const taskIds = readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number.parseInt(entry.name, 10))
    .sort((a, b) => a - b);

  const byTaskType: Record<string, TypeBreakdown> = {};
  const tasks: TaskReportRow[] = [];
  let evaluated = 0;
  let success = 0;
  let failure = 0;
  let error = 0;

  for (const taskId of taskIds) {
    const taskDir = join(resolvedDir, String(taskId));
    const logCandidate = join(taskDir, "webhand.jsonl");
    const harCandidate = join(taskDir, config.trace_file_name);
    const responseCandidate = join(taskDir, config.agent_response_file_name);
    const evalCandidate = join(taskDir, config.eval_result_file_name);

    const runEnd = readWebhandRunEnd(logCandidate);
    let taskType: string | null = null;
    let waStatus: string | null = null;
    if (existsSync(responseCandidate)) {
      try {
        const resp = JSON.parse(readFileSync(responseCandidate, "utf8")) as {
          task_type?: unknown;
          status?: unknown;
        };
        taskType = typeof resp.task_type === "string" ? resp.task_type : null;
        waStatus = typeof resp.status === "string" ? resp.status : null;
      } catch {
        // Leave null if malformed; keep the row in the report.
      }
    }
    const { score, eval_status } = readEvalScoreOnly(evalCandidate);

    const typeKey = taskType ?? "UNKNOWN";
    const bucket = byTaskType[typeKey] ?? { total: 0, evaluated: 0, success: 0, failure: 0, error: 0 };
    bucket.total += 1;
    if (eval_status !== null || score !== null) {
      evaluated += 1;
      bucket.evaluated += 1;
      if (eval_status === "success" || (eval_status === null && score === 1)) {
        success += 1;
        bucket.success += 1;
      } else if (eval_status === "error") {
        error += 1;
        bucket.error += 1;
      } else {
        failure += 1;
        bucket.failure += 1;
      }
    }
    byTaskType[typeKey] = bucket;

    tasks.push({
      task_id: taskId,
      status: runEnd.status ?? "incomplete",
      task_type: taskType,
      wa_status: waStatus,
      attempts: runEnd.attempts,
      score,
      eval_status,
      log_path: existsSync(logCandidate) ? logCandidate : null,
      har_path: existsSync(harCandidate) ? harCandidate : null,
      agent_response_path: existsSync(responseCandidate) ? responseCandidate : null,
    });
  }

  const evalResultsCandidate = join(resolvedDir, "eval_results.json");
  return {
    output_dir: resolvedDir,
    eval_results_path: existsSync(evalResultsCandidate) ? evalResultsCandidate : null,
    total: tasks.length,
    evaluated,
    unevaluated: tasks.length - evaluated,
    success,
    failure,
    error,
    by_task_type: byTaskType,
    tasks,
  };
}

function formatPct(num: number, den: number): string {
  if (!den) return "-";
  return `${((num / den) * 100).toFixed(1)}%`;
}

export function formatReportMarkdown(report: RunDirReport): string {
  const lines: string[] = [];
  lines.push(`## WebArena-Verified Report (\`${report.output_dir}\`)`);
  lines.push("");
  lines.push(
    `- **webarena_verified_score (separate from \`tasks/\` \`verify()\`)**: **${report.success} / ${report.evaluated}** (${formatPct(report.success, report.evaluated)}) — total=${report.total}, success=${report.success}, failure=${report.failure}, error=${report.error}, unevaluated=${report.unevaluated}`,
  );
  if (report.eval_results_path) {
    lines.push(`- **eval_results.json**: \`${report.eval_results_path}\``);
  }
  lines.push("");
  lines.push("| task_type | total | evaluated | success | failure | error | rate |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const typeKey of Object.keys(report.by_task_type).sort()) {
    const b = report.by_task_type[typeKey];
    lines.push(
      `| \`${typeKey}\` | ${b.total} | ${b.evaluated} | ${b.success} | ${b.failure} | ${b.error} | ${formatPct(b.success, b.evaluated)} |`,
    );
  }
  lines.push("");
  lines.push(
    "| task_id | status | task_type | wa_status | attempts | webarena_verified_score | log | har | agent_response |",
  );
  lines.push("|---:|---|---|---|---:|---|---|---|---|");
  for (const row of report.tasks) {
    const scoreCell =
      row.score !== null || row.eval_status !== null ? `\`${row.score ?? "?"}\` (${row.eval_status ?? "?"})` : "-";
    lines.push(
      `| ${row.task_id} | \`${row.status}\` | ${row.task_type ? `\`${row.task_type}\`` : "-"} | ${row.wa_status ? `\`${row.wa_status}\`` : "-"} | ${row.attempts ?? "-"} | ${scoreCell} | ${row.log_path ?? "-"} | ${row.har_path ?? "-"} | ${row.agent_response_path ?? "-"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
