/**
 * Research tasks: a fixed goal and an independent verify(). They live in the research repository's
 * tasks/ folder and, like this loader, are never shipped in the package. They are the only evidence of
 * success in experiments.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "../src/browser/index.ts";
import type { Verdict } from "../src/core/types.ts";
import type { ScriptStep } from "../src/policies/scripted.ts";

export interface Task {
  GOAL: string;
  SCRIPT: ScriptStep[];
  /** The start URL; root is the repository root. */
  startUrl(root: string): string;
  /** Reads the final page directly. It never looks at the agent's DONE or its history. */
  verify(browser: Browser): Promise<Verdict>;
}

/** The task cannot be loaded. */
export class TaskError extends Error {
  override name = "TaskError";
}

/** Lists all task names under `tasks/*.ts`, sorted alphabetically. */
export function listTasks(root = process.cwd()): string[] {
  const dir = join(root, "tasks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.slice(0, -3))
    .sort();
}

export async function loadTask(name: string, root = process.cwd()): Promise<Task> {
  if (!/^[\p{L}\p{N}_-]+$/u.test(name)) throw new TaskError(`Unknown task: ${name}`);
  const file = join(root, "tasks", `${name}.ts`);
  if (!existsSync(file)) {
    if (!existsSync(join(root, "tasks"))) {
      throw new TaskError(`Unknown task: ${name}. Tasks are for the research repository; run from its root`);
    }
    throw new TaskError(`Unknown task: ${name}`);
  }
  try {
    return (await import(pathToFileURL(file).href)) as Task;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TaskError(`Could not load task ${name} (TypeScript tasks need Node 22.18 or later): ${message}`);
  }
}
