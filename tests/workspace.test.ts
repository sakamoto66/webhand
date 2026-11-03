import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import * as runbook from "../src/runbook.ts";
import * as session from "../src/session.ts";
import * as workspace from "../src/workspace.ts";
import { inDirectory, tmpPath } from "./helpers.ts";

test("everything of the user lives under the workspace", () => {
  const dir = tmpPath();
  vi.stubEnv("WEBHAND_HOME", dir);
  expect(runbook.root("user")).toBe(join(dir, "runbooks"));
  expect(session.home()).toBe(join(dir, "state"));
});

test("env file fills only unset variables", () => {
  const dir = tmpPath();
  vi.stubEnv("WEBHAND_HOME", dir);
  vi.stubEnv("TYPESAFE_API_KEY", undefined);
  vi.stubEnv("TYPESAFE_MODEL", "kept");
  writeFileSync(join(dir, ".env"), '# comment\nexport TYPESAFE_API_KEY="abc"\nTYPESAFE_MODEL=other\n');
  workspace.loadEnv();
  expect(process.env.TYPESAFE_API_KEY).toBe("abc");
  expect(process.env.TYPESAFE_MODEL).toBe("kept");
});

test("the project folder is the nearest .webhand from the current directory up", () => {
  const project = realpathSync(tmpPath());
  mkdirSync(join(project, ".webhand"));
  mkdirSync(join(project, "a", "b"), { recursive: true });
  expect(workspace.projectRoot(join(project, "a", "b"))).toBe(join(project, ".webhand"));
  const inner = join(project, "a", ".webhand");
  mkdirSync(inner);
  expect(workspace.projectRoot(join(project, "a", "b"))).toBe(inner);
});

test("without a project folder, a new one goes to the current directory outside git", () => {
  const dir = realpathSync(tmpPath());
  expect(workspace.projectRoot(dir)).toBeNull();
  expect(workspace.projectWriteRoot(dir)).toBe(join(dir, ".webhand"));
});

test("the user folder is never taken for a project folder", () => {
  const dir = realpathSync(tmpPath());
  vi.stubEnv("WEBHAND_HOME", join(dir, ".webhand"));
  mkdirSync(join(dir, ".webhand"));
  expect(workspace.projectRoot(dir)).toBeNull();
});

test("scopes are read project first", async () => {
  const project = realpathSync(tmpPath());
  mkdirSync(join(project, ".webhand"));
  await inDirectory(project, () => {
    expect(workspace.roots().map((r) => r.scope)).toEqual(["project", "user"]);
    expect(workspace.scopeRoot("project")).toBe(join(project, ".webhand"));
    expect(workspace.scopeRoot("user")).toBe(workspace.home());
  });
});
