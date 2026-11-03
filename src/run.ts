/** Harness smoke test: the fixed script, no model. Agent runs go through the webhand CLI. */

import { join } from "node:path";
import { parseArgs } from "node:util";
import { Budget, GOAL_REPORTED, runAgent } from "./agent.ts";
import { Browser } from "./browser.ts";
import { gitState, Recorder, summarize } from "./metrics.ts";
import { ScriptedPolicy } from "./policies/scripted.ts";
import { describeError, pyStr, stamp, utcIso } from "./py.ts";
import { loadTask, type Task, type Verdict } from "./tasks.ts";

const ROOT = process.cwd();

interface Options {
  headed: boolean;
  maxActions: number;
  maxDecisions: number;
}

async function runOnce(taskName: string, task: Task, repeat: number, folder: string, options: Options) {
  const recorder = new Recorder(join(folder, `${taskName}-scripted-${repeat}.jsonl`));
  let browser: Browser | null = null;
  let result: Record<string, unknown> = { status: "error", reason: null };
  let verdict: Verdict = { success: false, evidence: null };
  try {
    const policy = new ScriptedPolicy(task.SCRIPT);
    browser = await Browser.open(task.startUrl(ROOT), { headless: !options.headed });
    recorder.event("run_start", {
      task: taskName,
      goal: task.GOAL,
      policy: "scripted",
      repeat,
      config: policy.config(),
      chrome: browser.version,
      git: gitState(),
      started_at: utcIso(),
    });
    const plan = { goal: task.GOAL, steps: [], values: [] };
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
  console.log(`${taskName}#${repeat}: ${result.status} verified=${pyStr(verdict.success)} reason=${pyStr(reason)}`);
  return verdict.success === true;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      repeat: { type: "string", default: "1" },
      headed: { type: "boolean", default: false },
      "max-actions": { type: "string", default: String(Budget.MAX_ACTIONS) },
      "max-decisions": { type: "string", default: String(Budget.MAX_DECISIONS) },
    },
  });
  if (!values.task) throw new Error("--task is required");
  const task = await loadTask(values.task);
  const folder = join(ROOT, "runs", stamp());
  const options = {
    headed: values.headed ?? false,
    maxActions: Number(values["max-actions"]),
    maxDecisions: Number(values["max-decisions"]),
  };
  const passed: boolean[] = [];
  for (let repeat = 1; repeat <= Number(values.repeat); repeat++) {
    passed.push(await runOnce(values.task, task, repeat, folder, options));
  }
  console.log(`${passed.filter(Boolean).length}/${passed.length} verified. Logs: ${folder}`);
  return passed.every(Boolean) ? 0 : 1;
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
