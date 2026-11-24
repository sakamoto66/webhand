/** GitHub-Flavored Markdown formatter for `webhand extract --format markdown`. */

import type { Extraction } from "../types.ts";

const escapeCell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function formatMarkdown(extraction: Extraction): string {
  const { records, columns } = extraction;
  const countDetail =
    extraction.result === "COUNT_MISMATCH"
      ? `${extraction.result} (expected ${extraction.expected}, observed ${extraction.count})`
      : extraction.reason
        ? `${extraction.result} (${extraction.reason})`
        : extraction.result;

  const lines: string[] = [
    `# Extract: ${extraction.kind}`,
    "",
    `- **URL**: ${extraction.url}`,
    `- **Captured**: ${extraction.at}`,
    `- **Result**: ${countDetail}`,
    `- **Count**: ${extraction.count}`,
  ];

  if (extraction.missingColumns.length > 0) {
    lines.push(`- **Missing columns**: ${extraction.missingColumns.join(", ")}`);
  }

  if (columns.length > 0 && records.length > 0) {
    lines.push(
      "",
      `| # | ${columns.map(escapeCell).join(" | ")} |`,
      `| --- | ${columns.map(() => "---").join(" | ")} |`,
      ...records.map(
        (record, idx) => `| ${idx + 1} | ${columns.map((col) => escapeCell(record.values[col] ?? "")).join(" | ")} |`,
      ),
    );
  }

  if (extraction.notes.length > 0) {
    lines.push("", "## Notes", "", ...extraction.notes.map((note) => `- ${note}`));
  }

  return lines.join("\n");
}
