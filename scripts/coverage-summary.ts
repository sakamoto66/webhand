/** Writes coverage/coverage-summary.json as a Markdown table to the GitHub job summary (or stdout). */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

interface Metric {
  total: number;
  covered: number;
  pct: number | "Unknown";
}

type Entry = Record<"lines" | "statements" | "functions" | "branches", Metric>;

const SOURCE = resolve("coverage/coverage-summary.json");
const COLUMNS = ["lines", "statements", "functions", "branches"] as const;

function cell(metric: Metric): string {
  const pct = typeof metric.pct === "number" ? `${metric.pct.toFixed(2)}%` : "-";
  return `${pct} (${metric.covered}/${metric.total})`;
}

function row(name: string, entry: Entry): string {
  return `| ${name} | ${COLUMNS.map((column) => cell(entry[column])).join(" | ")} |`;
}

function render(): string {
  if (!existsSync(SOURCE)) return "## Coverage\n\nNo coverage report was produced.\n";
  const summary: Record<string, Entry> = JSON.parse(readFileSync(SOURCE, "utf8"));
  const { total, ...files } = summary;
  const header = "| File | Lines | Statements | Functions | Branches |\n| --- | ---: | ---: | ---: | ---: |";
  const fileRows = Object.entries(files)
    .map(([path, entry]) => [relative(process.cwd(), path), entry] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, entry]) => row(`\`${path}\``, entry));
  return [
    "## Coverage",
    "",
    header,
    row("**Total**", total),
    "",
    "<details><summary>By file</summary>",
    "",
    header,
    ...fileRows,
    "",
    "</details>",
    "",
  ].join("\n");
}

const markdown = render();
const target = process.env.GITHUB_STEP_SUMMARY;
if (target) appendFileSync(target, markdown);
else process.stdout.write(markdown);
