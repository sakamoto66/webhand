import type { Args } from "../args.ts";
import { type Expectation, evaluate, type Outcome, parseExpectation } from "../check/index.ts";
import { quote } from "../core/format.ts";
import { logOnce } from "../core/metrics.ts";
import * as checkfile from "../storage/checkfile.ts";
import { parseValues } from "../storage/runbook/index.ts";
import { CHECK_FAIL, CHECK_INCONCLUSIVE, CliExit, OK, print } from "./context.ts";
import { idOption } from "./options.ts";
import { openPage, requireSession } from "./shared.ts";
import type { CommandDef } from "./types.ts";

/** What to compare: --expect as given, or the expectations of a saved check (--saved NAME:ID), which Claude cannot edit. */
function chosen(args: Args): {
  items: Expectation[];
  saved: { name: string; id: string; digest: string; manual: string[] } | null;
} {
  const expects = (args.expect ?? []) as string[];
  if (args.saved && expects.length) throw new CliExit("Give --expect or --saved, not both");
  if (!args.saved) {
    if (!expects.length) throw new CliExit("Give --expect KIND:ARGS, or --saved NAME:ID");
    return { items: expects.map(parseExpectation), saved: null };
  }
  const at = String(args.saved).lastIndexOf(":");
  const name = at < 0 ? "" : String(args.saved).slice(0, at);
  const id = at < 0 ? "" : String(args.saved).slice(at + 1);
  if (!name || !id) throw new CliExit(`Expected --saved service/name:ID, got ${quote(args.saved)}`);
  const file = checkfile.load(name);
  const check = file.checks.find((item) => item.id === id);
  if (!check) throw new CliExit(`Saved check ${quote(name)} has no ${quote(id)}`);
  if (file.status !== "approved" && !args.allow_draft) {
    throw new CliExit(
      `${name} is a draft: a person must approve it before a regression uses it (or pass --allow-draft to trial it)`,
    );
  }
  if (args.production && file.env !== "read-only") {
    throw new CliExit(`${name} is not read-only (env=${file.env}); it must not run against production`);
  }
  const values = parseValues((args.param ?? []) as string[]);
  const manual = check.manual.map((line) => checkfile.fill(line, values));
  return { items: checkfile.expectations(check, values), saved: { name, id, digest: file.digest, manual } };
}

/**
 * Compares Claude's expectations with the page as it is now, from one observation. Read-only: it never acts,
 * and what it prints is evidence for Claude's judgment, not the judgment.
 */
async function commandCheck(args: Args): Promise<number> {
  const { items, saved } = chosen(args);
  const state = requireSession();
  await openPage(state, null, false, args.read ? ["text"] : []);
  const page = state.page;
  const outcomes: Outcome[] = items.map((item) => evaluate(page, item));
  const label = saved ? ` for ${saved.name}#${saved.id} (digest ${saved.digest})` : "";
  print(`CHECK ${items.length} expectations${label} on ${page.url}`);
  outcomes.forEach((outcome, at) => {
    const reason = outcome.reason ? ` ${outcome.reason}` : "";
    print(`${at + 1} ${outcome.verdict}${reason}  ${quote(items[at].raw)}  ${outcome.evidence}`);
  });
  for (const line of saved?.manual ?? []) print(`MANUAL (Claude judges by reading the page)  ${quote(line)}`);
  const count = (verdict: string) => outcomes.filter((outcome) => outcome.verdict === verdict).length;
  print(`RESULT: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("INCONCLUSIVE")} INCONCLUSIVE`);
  const verdict = count("FAIL") ? "FAIL" : count("INCONCLUSIVE") ? "INCONCLUSIVE" : "PASS";
  logOnce(state.log, "check", {
    results: items.map((item, at) => ({
      expect: item.raw,
      verdict: outcomes[at].verdict,
      reason: outcomes[at].reason,
    })),
  });
  // What a later regression compares with: the check's version, which expectation set, and the automatic verdict.
  if (saved) {
    logOnce(state.log, "check_run", {
      check: saved.name,
      id: saved.id,
      digest: saved.digest,
      verdict,
      manual: saved.manual.length,
      at: new Date().toISOString(),
    });
  }
  if (verdict === "FAIL") return CHECK_FAIL;
  return verdict === "INCONCLUSIVE" ? CHECK_INCONCLUSIVE : OK;
}

export const checkCommand: CommandDef = {
  name: "check",
  session: "required",
  spec: () => ({
    help: "Claude: compare expectations with the page as it is now (read-only; evidence, not the verdict)",
    options: [
      idOption(),
      {
        name: "expect",
        type: "string",
        multiple: true,
        metavar: "KIND:ARGS",
        help: "text:S, no-text:S, field:LABEL=V, checked:LABEL=true|false, count:ROLE=N, url:/path, title:S",
      },
      {
        name: "saved",
        type: "string",
        metavar: "service/name:ID",
        help: "Use the expectations of a saved check (.webhand/checks) instead of --expect; they cannot be edited here",
      },
      { name: "param", type: "string", multiple: true, metavar: "KEY=VALUE", help: "A saved check's parameter" },
      { name: "allow-draft", type: "boolean", help: "Trial a saved check no person has approved yet" },
      { name: "production", type: "boolean", help: "The page is production: a saved check must be env=read-only" },
      {
        name: "read",
        type: "boolean",
        help: "Read the text of the whole page beyond the viewport for this check only (no replan, no attempt used)",
      },
    ],
  }),
  run: commandCheck,
};
