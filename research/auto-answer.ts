/**
 * PreToolUse hook for AskUserQuestion in research/batch.ts sessions: answers with a fixed sentence, so no option is
 * chosen and nobody types. Each answer is appended to WEBHAND_HOME/auto_answers.jsonl. Not shipped.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT = "お答えできません。手元の情報だけで進めてください。";
const HUMAN = "対応できません。手元の情報だけで進めてください。";
/** A question only a person can act on: signing in, a password, a code, or a CAPTCHA. */
const HUMAN_WORDS =
  /captcha|ログイン|サインイン|パスワード|認証コード|確認コード|sign.?in|log.?in|password|verification code/i;

interface Question {
  question: string;
  options?: { label?: string; description?: string }[];
}

/** The hook's reply to a tool call; null for any other tool. */
export function reply(call: { tool_name?: string; tool_input?: { questions?: Question[] } }) {
  if (call.tool_name !== "AskUserQuestion") return null;
  const answers = Object.fromEntries(
    (call.tool_input?.questions ?? []).map((one) => {
      const options = (one.options ?? []).map((option) => `${option.label ?? ""} ${option.description ?? ""}`);
      return [one.question, HUMAN_WORDS.test([one.question, ...options].join(" ")) ? HUMAN : DEFAULT];
    }),
  );
  const updatedInput = { ...call.tool_input, answers };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const answered = reply(JSON.parse(readFileSync(0, "utf8")));
  if (answered) {
    const answers = Object.values(answered.hookSpecificOutput.updatedInput.answers);
    try {
      const note = { at: new Date().toISOString(), answers };
      appendFileSync(join(process.env.WEBHAND_HOME || ".", "auto_answers.jsonl"), `${JSON.stringify(note)}\n`);
    } catch {
      // Answering matters more than the note.
    }
    process.stdout.write(JSON.stringify(answered));
  }
}
