/**
 * The webhand CLI with research tasks. Not shipped: run it from the research repository's root as
 * `node research/webhand.ts COMMAND ...` in place of `webhand COMMAND ...`.
 *
 * `start --task NAME` takes the GOAL and start URL from tasks/NAME.ts and labels the run with it.
 * `finish` then runs the task's verify() on the final page. Every other command is passed through.
 */

import { CliExit, type Hooks, type IO, main, UsageError } from "../src/cli.ts";
import * as session from "../src/session.ts";
import { loadTask, TaskError } from "./tasks.ts";

/** Takes `--task NAME` or `--task=NAME` out of the arguments. */
function takeTask(argv: string[]): [string | null, string[]] {
  const rest: string[] = [];
  let task: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--task") {
      task = argv[++i] ?? "";
    } else if (arg.startsWith("--task=")) {
      task = arg.slice("--task=".length);
    } else {
      rest.push(arg);
    }
  }
  if (task === "") throw new UsageError("--task needs a task name");
  return [task, rest];
}

async function load(name: string) {
  try {
    return await loadTask(name);
  } catch (error) {
    if (error instanceof TaskError) throw new CliExit(error.message);
    throw error;
  }
}

/** Runs one command with research tasks and returns its exit code, as main() does. */
export async function run(argv: string[], io?: IO): Promise<number> {
  const [command, ...args] = argv;
  if (command === "start") {
    const [name, rest] = takeTask(args);
    if (name === null) return main(argv, io);
    if (rest.some((arg) => /^--(goal|url)(=|$)/.test(arg))) {
      throw new CliExit("A task supplies its own goal and start URL. Drop --goal and --url");
    }
    const task = await load(name);
    // An A/B of the flow sets it for the session, so Claude's instructions are the same in both conditions.
    const flow = process.env.WEBHAND_RESEARCH_FLOW;
    const forced = flow && !rest.some((arg) => /^--flow(=|$)/.test(arg)) ? ["--flow", flow] : [];
    const argv2 = ["start", "--goal", task.GOAL, "--url", task.startUrl(process.cwd()), ...forced, ...rest];
    return main(argv2, io, { task: name });
  }
  if (command === "finish") {
    session.use(session.idFrom(args));
    const name = session.load()?.task;
    const hooks: Hooks = name ? { verify: async (browser) => (await loadTask(name)).verify(browser) } : {};
    return main(argv, io, hooks);
  }
  return main(argv, io);
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
  // A leftover connection must not keep the process alive after its output is written.
  process.exit(code);
}
