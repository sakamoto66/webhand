import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8"));

test("package.json and every plugin manifest share the same version and name", () => {
  const pkg = readJson("package.json");
  for (const path of [".claude-plugin/plugin.json", ".antigravity-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    const manifest = readJson(path);
    expect(manifest.name, path).toBe(pkg.name);
    expect(manifest.version, path).toBe(pkg.version);
  }
});

test("marketplace and hook configs are valid JSON and reference existing paths", () => {
  expect(readJson(".claude-plugin/marketplace.json").name).toBe("webhand");
  expect(readJson(".agents/plugins/marketplace.json").name).toBe("webhand");
  const claudeHooks = readJson("hooks/hooks.json") as { hooks: { PreToolUse: unknown[] } };
  expect(claudeHooks.hooks.PreToolUse.length).toBeGreaterThan(0);
  const agyHooks = readJson("hooks.json") as { "webhand-allow-control": { PreToolUse: unknown[] } };
  expect(agyHooks["webhand-allow-control"].PreToolUse.length).toBeGreaterThan(0);
});

test("research skills live in .agents/skills and are symlinked from .claude/skills", () => {
  const agentSkills = readdirSync(".agents/skills").sort();
  const claudeSkills = readdirSync(".claude/skills").sort();
  expect(agentSkills.length).toBeGreaterThan(0);
  expect(claudeSkills).toEqual(agentSkills);
  for (const name of agentSkills) {
    expect(lstatSync(join(".claude/skills", name)).isSymbolicLink(), name).toBe(true);
    expect(readFileSync(join(".claude/skills", name, "SKILL.md"), "utf8")).toBe(
      readFileSync(join(".agents/skills", name, "SKILL.md"), "utf8"),
    );
  }
});
