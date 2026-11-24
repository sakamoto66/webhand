/** Shared helpers for browser integration tests. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTask } from "../../research/tasks.ts";
import type { Page } from "../../src/core/types.ts";
import { tmpPath } from "../helpers.ts";

export const task = await loadTask("hotel_filter");

// biome-ignore lint/suspicious/noExplicitAny: observed actions are untyped JSON.
export const find = (page: Page, predicate: (a: any) => boolean) => page.actions.find(predicate);

export function fixture(name: string, html: string): string {
  const file = join(tmpPath(), name);
  writeFileSync(file, html);
  return pathToFileURL(file).href;
}
