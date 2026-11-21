import type { Args } from "../args.ts";
import { type Expectation, ExpectationError, evaluate, type Outcome, parseExpectation } from "../check.ts";
import { quote } from "../format.ts";
import { logOnce } from "../metrics.ts";

import { CHECK_FAIL, CHECK_INCONCLUSIVE, CliExit, OK, print } from "./context.ts";
import { openPage, requireSession } from "./shared.ts";

/**
 * Compares Claude's expectations with the page as it is now, from one observation. Read-only: it never acts,
 * and what it prints is evidence for Claude's judgment, not the judgment.
 */
export async function commandCheck(args: Args): Promise<number> {
  let items: Expectation[];
  try {
    items = (args.expect as string[]).map(parseExpectation);
  } catch (error) {
    if (error instanceof ExpectationError) throw new CliExit(error.message);
    throw error;
  }
  const state = requireSession();
  await openPage(state);
  const page = state.page;
  const outcomes: Outcome[] = items.map((item) => evaluate(page, item));
  print(`CHECK ${items.length} expectations on ${page.url}`);
  outcomes.forEach((outcome, at) => {
    const reason = outcome.reason ? ` ${outcome.reason}` : "";
    print(`${at + 1} ${outcome.verdict}${reason}  ${quote(items[at].raw)}  ${outcome.evidence}`);
  });
  const count = (verdict: string) => outcomes.filter((outcome) => outcome.verdict === verdict).length;
  print(`RESULT: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("INCONCLUSIVE")} INCONCLUSIVE`);
  logOnce(state.log, "check", {
    results: items.map((item, at) => ({
      expect: item.raw,
      verdict: outcomes[at].verdict,
      reason: outcomes[at].reason,
    })),
  });
  if (count("FAIL")) return CHECK_FAIL;
  return count("INCONCLUSIVE") ? CHECK_INCONCLUSIVE : OK;
}
