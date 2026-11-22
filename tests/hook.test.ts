import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { decide } from "../hooks/ask-allow-control.mjs";

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const agy = (CommandLine: string) => ({
  hookEventName: "PreToolUse",
  toolCall: { id: "toolu_01", name: "run_command", args: { CommandLine } },
});

test("Claude Code: a webhand command with --allow-control asks the person, naming the button", () => {
  for (const command of [
    'webhand start --read-only --allow-control "同意して続ける" --goal x',
    "npx -y webhand@0.5 replan --reason r --allow-control More",
    "node research/webhand.ts start --read-only --allow-control='Show more'",
    "cd /w && webhand start --allow-control 'もっと見る'",
  ]) {
    const result = decide(bash(command));
    expect(
      result && "hookSpecificOutput" in result ? result.hookSpecificOutput.permissionDecision : null,
      command,
    ).toBe("ask");
    expect(
      result && "hookSpecificOutput" in result ? result.hookSpecificOutput.permissionDecisionReason : "",
    ).toContain("press");
  }
  const single = decide(bash('webhand start --allow-control "同意して続ける"'));
  expect(single && "hookSpecificOutput" in single ? single.hookSpecificOutput.permissionDecisionReason : "").toContain(
    "「同意して続ける」",
  );
});

test("Antigravity: a webhand command with --allow-control returns force_ask, naming the button", () => {
  for (const command of [
    'webhand start --read-only --allow-control "同意して続ける" --goal x',
    "npx -y webhand@0.5 replan --reason r --allow-control More",
    "node research/webhand.ts start --read-only --allow-control='Show more'",
  ]) {
    const result = decide(agy(command));
    expect(result && "decision" in result ? result.decision : null, command).toBe("force_ask");
    expect(result && "reason" in result ? result.reason : "").toContain("press");
  }
  const single = decide(agy('webhand start --allow-control "同意して続ける"'));
  expect(single && "reason" in single ? single.reason : "").toContain("「同意して続ける」");
});

test("other commands are left alone for both Claude Code and Antigravity", () => {
  for (const command of [
    "webhand start --read-only --goal x",
    "webhand run",
    "webhand extract table",
    'echo "--allow-control"',
    "git commit -m 'about --allow-control'",
    "grep -r allow-control src",
  ]) {
    expect(decide(bash(command)), command).toBeNull();
    expect(decide(agy(command)), command).toBeNull();
  }
  expect(decide({ tool_name: "Read", tool_input: { file_path: "x" } })).toBeNull();
  expect(decide({ toolCall: { name: "read_file", args: { Path: "x" } } })).toBeNull();
  expect(decide(null)).toBeNull();
});

test("run as a command, it reads stdin and prints the decision JSON, or nothing", () => {
  const run = (payload: unknown) =>
    execFileSync("node", ["hooks/ask-allow-control.mjs"], { input: JSON.stringify(payload) }).toString();
  expect(JSON.parse(run(bash('webhand start --allow-control "X"'))).hookSpecificOutput.permissionDecision).toBe("ask");
  expect(JSON.parse(run(agy('webhand start --allow-control "X"'))).decision).toBe("force_ask");
  expect(run(bash("webhand run"))).toBe("");
  expect(run(agy("webhand run"))).toBe("");
});
