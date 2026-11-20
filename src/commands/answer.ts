/** The `answer` command. */

import type { Args } from "../args.ts";
import { browserUrl } from "../engines/chrome.ts";
import { logOnce, safeUrl } from "../metrics.ts";
import * as runbook from "../runbook.ts";
import * as session from "../session.ts";

import { FAILED, print } from "./context.ts";
import { ANSWERABLE } from "./report.ts";
import { commandRun } from "./run.ts";
import { mergeValues, openableUrl, openPage, parseFiles, parseValues, requireSession } from "./shared.ts";

/** v2: Claude answers Jev's question. The same attempt continues: history and budget are kept. */
export async function commandAnswer(args: Args): Promise<number> {
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
    let url: string;
    try {
      url = runbook.resolveUrl(args.url);
    } catch (error) {
      if (!(error instanceof runbook.RunbookError)) throw error;
      print(`REJECTED: ${error.message.replace("start_url", "--url")}`);
      return FAILED;
    }
    if (!openableUrl(url)) {
      print("REJECTED: --url needs an http, https, or file URL, or a local file path");
      return FAILED;
    }
    await openPage(state, browserUrl(url, state.chrome ?? "linux"), true);
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
  return commandRun({ ...args, value: [], human_done: false });
}
