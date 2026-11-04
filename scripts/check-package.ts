/**
 * Checks what `npm publish` would ship. Run it after `npm run build`.
 * Fails when the package holds a file outside `files`' intent, such as research code, or a dist/
 * file left over from a source that no longer exists (tsc does not delete old outputs).
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

interface Pack {
  files: { path: string }[];
}

const FIXED = new Set([
  "package.json",
  "LICENSE",
  "THIRD_PARTY_LICENSE_jev-ultrafast.txt",
  "README.md",
  "README.ja.md",
]);

function packedFiles(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
  const [pack]: Pack[] = JSON.parse(out);
  return pack.files.map((file) => file.path).sort();
}

function expectedOutputs(): Set<string> {
  return new Set(
    readdirSync("src", { recursive: true, encoding: "utf8" })
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"))
      .map((path) => `dist/${path.replace(/\.ts$/, ".js")}`),
  );
}

function problems(files: string[]): string[] {
  const found: string[] = [];
  const expected = expectedOutputs();
  for (const path of files) {
    if (FIXED.has(path) || path.startsWith("assets/")) continue;
    if (!path.startsWith("dist/")) found.push(`${path}: not part of the package`);
    else if (!expected.has(path)) found.push(`${path}: no matching source in src/ (stale build output?)`);
  }
  for (const path of expected) {
    if (!files.includes(path)) found.push(`${path}: missing (run npm run build first)`);
  }
  return found;
}

const files = packedFiles();
const found = problems(files);
if (found.length > 0) {
  process.stderr.write(`The package would ship the wrong files:\n${found.map((line) => `- ${line}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Package contents OK (${files.length} files).\n`);
