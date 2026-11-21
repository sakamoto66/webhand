import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { decide } from "../hooks/ask-allow-control.mjs";

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

test("a webhand command with --allow-control asks the person, naming the button", () => {
  for (const command of [
    'webhand start --read-only --allow-control "同意して続ける" --goal x',
    "npx -y webhand@0.4 replan --reason r --allow-control More",
    "node research/webhand.ts start --read-only --allow-control='Show more'",
    "cd /w && webhand start --allow-control 'もっと見る'",
  ]) {
    const result = decide(bash(command));
    expect(result?.hookSpecificOutput.permissionDecision, command).toBe("ask");
    expect(result?.hookSpecificOutput.permissionDecisionReason).toContain("press");
  }
  expect(
    decide(bash('webhand start --allow-control "同意して続ける"'))?.hookSpecificOutput.permissionDecisionReason,
  ).toContain("「同意して続ける」");
});

test("other commands are left alone", () => {
  for (const command of [
    "webhand start --read-only --goal x",
    "webhand run",
    "webhand extract table",
    'echo "--allow-control"',
    "git commit -m 'about --allow-control'",
    "grep -r allow-control src",
  ]) {
    expect(decide(bash(command)), command).toBeNull();
  }
  expect(decide({ tool_name: "Read", tool_input: { file_path: "x" } })).toBeNull();
  expect(decide(null)).toBeNull();
});

test("run as a command, it reads stdin and prints the decision JSON, or nothing", () => {
  const run = (command: string) =>
    execFileSync("node", ["hooks/ask-allow-control.mjs"], { input: JSON.stringify(bash(command)) }).toString();
  expect(JSON.parse(run('webhand start --allow-control "X"')).hookSpecificOutput.permissionDecision).toBe("ask");
  expect(run("webhand run")).toBe("");
});
