/**
 * Copies package.json's version into the plugin manifests and the skills, which pin the CLI they run.
 * `npm version X.Y.Z --no-git-tag-version` runs it; `--check` only reports what differs.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MANIFESTS = [".claude-plugin/plugin.json", ".antigravity-plugin/plugin.json", ".codex-plugin/plugin.json"];

function skillPages(): string[] {
  return readdirSync("skills", { recursive: true, encoding: "utf8" })
    .map((path) => `skills/${path.replaceAll("\\", "/")}`)
    .filter((path) => path.endsWith(".md"))
    .sort();
}

/** `webhand@X.Y` follows the minor version, `webhand@X.Y.Z` the full one. `webhand@latest` is left alone. */
export function syncText(text: string, version: string): string {
  const minor = version.split(".").slice(0, 2).join(".");
  return text.replace(/\bwebhand@\d+\.\d+(\.\d+)?/g, (_, patch) => `webhand@${patch ? version : minor}`);
}

export function syncManifest(text: string, version: string): string {
  const line = /^( {2}"version": )"[^"]*"/m;
  if (!line.test(text)) throw new Error('no top-level "version" line');
  return text.replace(line, `$1"${version}"`);
}

/** The files that differ from the version, with their new text. */
export function outdated(version: string): Map<string, string> {
  const changes = new Map<string, string>();
  const jobs = [
    ...MANIFESTS.map((path) => [path, syncManifest] as const),
    ...skillPages().map((path) => [path, syncText] as const),
  ];
  for (const [path, sync] of jobs) {
    const before = readFileSync(path, "utf8");
    const after = sync(before, version);
    if (after !== before) changes.set(path, after);
  }
  return changes;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`);
  const changes = outdated(version);
  const check = process.argv.includes("--check");
  if (!check) for (const [path, text] of changes) writeFileSync(path, text);
  for (const path of changes.keys()) process.stdout.write(`${check ? "outdated" : "updated"}: ${path}\n`);
  if (check && changes.size > 0) process.exit(1);
}
