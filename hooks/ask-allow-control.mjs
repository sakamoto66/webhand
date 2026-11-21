#!/usr/bin/env node
// PreToolUse hook for Bash: a webhand command that lets a read-only session press a button (--allow-control) is
// never run on Claude's say-so alone. The hook asks the person, showing the command and the button names, even when
// a skill's allowed-tools would let `webhand` run without a prompt. Any other command is left alone (no output).
// It reads the hook input (JSON) from stdin and prints the decision as JSON.

import { readFileSync } from "node:fs";

const FLAG = /(^|[\s"'])--allow-control(?=[\s="']|$)/;
const WEBHAND = /(^|[\s/"'])webhand(\.ts)?(@[\w.]+)?(?=[\s"']|$)/;

/** The decision for a hook input, or null when the command is not one to ask about. */
export function decide(input) {
  const command = input?.tool_input?.command;
  if (input?.tool_name !== "Bash" || typeof command !== "string") return null;
  if (!FLAG.test(command) || !WEBHAND.test(command)) return null;
  const names = [...command.matchAll(/--allow-control(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/g)].map(
    (m) => m[1] ?? m[2] ?? m[3],
  );
  const shown = names.length ? names.map((n) => `「${n}」`).join("、") : "(a button)";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason:
        `webhand read-only session: this lets webhand press ${shown}, a button outside a form whose effect is not visible. ` +
        "Approve only if pressing it is acceptable (it may record a consent or change something).",
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = null;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // Not JSON: nothing to decide.
  }
  const decision = decide(input);
  if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
}
