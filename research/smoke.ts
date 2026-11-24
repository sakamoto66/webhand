/** Harness smoke test: the fixed script, no model. Agent runs go through research/webhand.ts. */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { Budget, GOAL_REPORTED, runAgent } from "../src/agent.ts";
import { Browser } from "../src/browser.ts";
import { describeError, show, stamp } from "../src/format.ts";
import { gitState, Recorder, summarize } from "../src/metrics.ts";
import { ScriptedPolicy } from "../src/policies/scripted.ts";
import type { Verdict } from "../src/types.ts";
import { listTasks, loadTask, type Task } from "./tasks.ts";

const ROOT = process.cwd();

/** Tasks whose startUrl is intentionally unreachable/canvas-only and require planner URL replanning (tested in vitest). */
const REPLAN_ONLY_TASKS = new Set(["canvas_seats", "item_moved"]);

interface Options {
  headed: boolean;
  flow: "v1" | "v2";
  maxActions: number;
  maxDecisions: number;
}

/** Why a task is skipped in `--all` scripted smoke mode, or null when it runs standalone. */
export function skipReason(taskName: string, task: Task, includeRemote: boolean, root = ROOT): string | null {
  const url = task.startUrl(root);
  if (!includeRemote && !url.startsWith("file://")) return "remote";
  if (REPLAN_ONLY_TASKS.has(taskName)) return "replan-only";
  if (!task.SCRIPT.length || task.SCRIPT.every((step) => step.operation === "SCROLL_DOWN" || step.operation === "BLOCKED")) {
    return "scan-or-replan";
  }
  return null;
}

async function runOnce(taskName: string, task: Task, repeat: number, folder: string, options: Options) {
  const recorder = new Recorder(join(folder, `${taskName}-scripted-${repeat}.jsonl`));
  let browser: Browser | null = null;
  let result: Record<string, unknown> = { status: "error", reason: null };
  let verdict: Verdict = { success: false, evidence: null };
  try {
    const policy = new ScriptedPolicy(task.SCRIPT);
    const view = options.flow === "v2" ? { whole: true } : null;
    browser = await Browser.open(task.startUrl(ROOT), { headless: !options.headed, view });
    recorder.event("run_start", {
      task: taskName,
      goal: task.GOAL,
      policy: "scripted",
      flow: options.flow,
      repeat,
      config: policy.config(),
      chrome: browser.version,
      git: gitState(),
      started_at: new Date().toISOString(),
    });
    const plan = { goal: task.GOAL, steps: [], values: [], ...(options.flow === "v2" ? { flow: "v2" as const } : {}) };
    const { page: _page, ...outcome } = await runAgent(
      browser,
      policy,
      plan,
      recorder,
      new Budget(options.maxActions, options.maxDecisions),
    );
    result = { ...outcome, status: outcome.outcome === GOAL_REPORTED ? "done" : "blocked" };
    verdict = await task.verify(browser);
  } catch (error) {
    // A failed run is data: keep it and move to the next one.
    result = { ...result, reason: describeError(error) };
  } finally {
    await browser?.close();
  }
  const summary = summarize(recorder.calls);
  recorder.event("run_end", { ...result, verified: verdict.success, evidence: verdict.evidence, ...summary });
  recorder.close();
  const reason = result.reason || result.detail || null;
  console.log(`${taskName}#${repeat}: ${result.status} verified=${show(verdict.success)} reason=${show(reason)}`);
  return verdict.success === true;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      tasks: { type: "string" },
      all: { type: "boolean", default: false },
      "include-remote": { type: "boolean", default: false },
      flow: { type: "string", default: "v2" },
      repeat: { type: "string", default: "1" },
      headed: { type: "boolean", default: false },
      "max-actions": { type: "string", default: String(Budget.MAX_ACTIONS) },
      "max-decisions": { type: "string", default: String(Budget.MAX_DECISIONS) },
    },
  });
  const flow = values.flow === "v1" ? "v1" : values.flow === "v2" ? "v2" : null;
  if (!flow) throw new Error("--flow must be v1 or v2");

  const requested = values.task
    ? [values.task]
    : values.tasks
      ? values.tasks
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : values.all
        ? listTasks(ROOT)
        : [];
  if (!requested.length) throw new Error("Pass --task NAME, --tasks A,B, or --all");

  const targets: { name: string; task: Task }[] = [];
  const skipped: string[] = [];
  for (const name of requested) {
    const task = await loadTask(name, ROOT);
    if (values.all && !values.task && !values.tasks) {
      const reason = skipReason(name, task, values["include-remote"] ?? false, ROOT);
      if (reason) {
        skipped.push(`${name} (${reason})`);
        continue;
      }
    }
    targets.push({ name, task });
  }

  const folder = join(ROOT, "runs", stamp());
  const options: Options = {
    headed: values.headed ?? false,
    flow,
    maxActions: Number(values["max-actions"]),
    maxDecisions: Number(values["max-decisions"]),
  };
  const passed: boolean[] = [];
  for (const { name, task } of targets) {
    for (let repeat = 1; repeat <= Number(values.repeat); repeat++) {
      passed.push(await runOnce(name, task, repeat, folder, options));
    }
  }
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} non-standalone tasks: ${skipped.join(", ")}`);
  }
  console.log(`${passed.filter(Boolean).length}/${passed.length} verified. Logs: ${folder}`);
  return passed.length > 0 && passed.every(Boolean) ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
