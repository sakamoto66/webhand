/** The `answer` command. */

import type { Args } from "../args.ts";
import { logOnce, safeUrl } from "../core/metrics.ts";
import { hostAllowed } from "../explore.ts";
import * as session from "../storage/session.ts";
import { FAILED, print } from "./context.ts";
import { fileOption, idOption, valueOption } from "./options.ts";
import { ANSWERABLE } from "./report.ts";
import { commandRun } from "./run.ts";
import { mergeValues, openPage, parseFiles, parseValues, requireSession, resolveCliUrl } from "./shared.ts";
import type { CommandDef } from "./types.ts";

/** v2: Claude answers Jev's question. The same attempt continues: history and budget are kept. */
async function commandAnswer(args: Args): Promise<number> {
  const state = requireSession();
  const plan = state.plan;
  if (plan.flow !== "v2") {
    print("REJECTED: answer is for --flow v2. Use replan");
    return FAILED;
  }
  if (!ANSWERABLE.includes(state.outcome)) {
    print(
      `REJECTED: nothing is waiting for an answer (${state.outcome ?? "the run is not stopped"}). Run: webhand run`,
    );
    return FAILED;
  }
  if (args.url) {
    const resolved = resolveCliUrl(args.url, state.chrome ?? "linux");
    if (!resolved.ok) {
      print(`REJECTED: ${resolved.reason}`);
      return FAILED;
    }
    if (state.allowed_domains?.length && !hostAllowed(resolved.url, state.allowed_domains)) {
      print(`REJECTED: --url is outside allowed_domains (${state.allowed_domains.join(", ")})`);
      return FAILED;
    }
    if (state.explore && !hostAllowed(resolved.url, state.explore.allow)) {
      print(`REJECTED: --url is outside --allow-domain (${state.explore.allow.join(", ")})`);
      return FAILED;
    }
    await openPage(state, resolved.url, true);
  }
  const values = parseValues(args.value);
  if (values.length) plan.values = mergeValues(plan.values, values);
  if (args.file.length) plan.files = mergeValues(plan.files ?? [], parseFiles(args.file));
  plan.instructions = [...(plan.instructions ?? []), args.note];
  // Not an action: it neither counts against the budget nor hides that the page did not change.
  state.history.push({
    step: state.history.length + 1,
    attempt: plan.attempt,
    kind: "answer",
    operation: "ANSWER",
    action: "Claude answered",
    text: null,
    url: state.page.url,
    page_changed: true,
  });
  logOnce(state.log, "answer", {
    attempt: plan.attempt,
    after: state.outcome,
    chars: [...args.note].length,
    values: values.map((v) => v.label),
    ...(args.url ? { url: safeUrl(args.url) } : {}),
  });
  state.outcome = null;
  session.save(state);
  return commandRun({ ...args, value: [], file: [], human_done: false });
}

export const answerCommand: CommandDef = {
  name: "answer",
  session: "required",
  spec: () => ({
    help: "Claude (v2): answer Jev's question and continue the same attempt",
    options: [
      idOption(),
      { name: "note", type: "string", required: true, help: "A short instruction for Jev; it sees it" },
      valueOption("Add or replace a value"),
      fileOption(),
      { name: "url", type: "string", help: "Open this page first (the same attempt continues)" },
    ],
  }),
  run: commandAnswer,
};
