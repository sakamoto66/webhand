import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { outdated, syncManifest, syncText } from "../scripts/sync-version.ts";

test("the manifests and the skills carry package.json's version", () => {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  expect([...outdated(version).keys()]).toEqual([]);
});

test("only the skills pin a version; other pages say webhand@latest or a placeholder", () => {
  const pages = execFileSync("git", ["ls-files", "-z", "--", "*.md", ":!skills/"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  expect(pages).toContain("README.md");
  const pinned = pages.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, i) => (/\bwebhand@v?\d/.test(line) ? [`${path}:${i + 1}`] : [])),
  );
  expect(pinned).toEqual([]);
});

test("a spec follows the minor or the full version, and latest is left alone", () => {
  expect(syncText("npx -y webhand@0.7:* `webhand@0.7.0` webhand@latest webhand@webhand", "1.2.3")).toBe(
    "npx -y webhand@1.2:* `webhand@1.2.3` webhand@latest webhand@webhand",
  );
});

test("only the top-level version of a manifest changes", () => {
  const text = '{\n  "version": "0.1.0",\n  "x": {\n    "version": "9"\n  }\n}\n';
  expect(syncManifest(text, "0.2.0")).toBe(text.replace("0.1.0", "0.2.0"));
  expect(() => syncManifest("{}", "0.2.0")).toThrow();
});
