/** The `drilldown` command: read-only list filtering via Jev + detail page auto-visit + structured extraction. */

import { inForce, refusal } from "../agent/readonly.ts";
import type { Args } from "../args.ts";
import { writeFileAtomic } from "../core/fs.ts";
import { Recorder } from "../core/metrics.ts";
import { MutationUncertain, type Policy, PolicyError, StalePage } from "../core/types.ts";
import type { Driver } from "../ipc/remote.ts";
import type { Collector } from "../scans/collect.ts";
import type { Reader } from "../scans/compare.ts";
import {
  DEFAULT_MAX_ITEMS,
  type DrilldownResult,
  drilldownScan,
  type FieldJudge,
  formatDrilldown,
  HARD_MAX_ITEMS,
  type LinkChooser,
} from "../scans/drilldown.ts";
import { loadMore, type MoreChooser } from "../scans/more.ts";
import * as session from "../storage/session.ts";
import { CliExit, deps, FAILED, OK, print, UNCERTAIN } from "./context.ts";
import { resolveOutPath } from "./extract.ts";
import { idOption } from "./options.ts";
import { attach, browserView, requireSession } from "./shared.ts";
import type { CommandDef } from "./types.ts";

const FORMATS = ["json", "table", "markdown"] as const;
type DrilldownFormat = (typeof FORMATS)[number];

interface RunDrilldownOptions {
  match?: string | null;
  linkText?: string | null;
  fields?: string[] | null;
  maxItems?: number;
  more?: string | null;
}

/** Shared drilldown runner used by both `webhand drilldown` and `webhand query`. */
export async function runDrilldown(
  state: session.State,
  browser: Driver,
  policy: Policy | null,
  recorder: Recorder,
  options: RunDrilldownOptions,
): Promise<DrilldownResult> {
  const moreControl = options.more ?? state.plan.more ?? null;
  let moreFn = null;
  if (moreControl) {
    if (!policy || !("more" in policy)) throw new CliExit("This chooser cannot find a control for more items");
    moreFn = loadMore(
      browser as Reader,
      policy as unknown as MoreChooser,
      state.plan,
      moreControl,
      recorder,
      state.plan.attempt,
      inForce(state) ? (action) => refusal(action, inForce(state) as NonNullable<ReturnType<typeof inForce>>) : null,
    );
  }
  const collector = options.match
    ? policy && "collect" in policy
      ? (policy as unknown as Collector)
      : (() => {
          throw new CliExit("This chooser cannot filter drilldown rows with --match");
        })()
    : null;
  const linkChooser = options.linkText?.trim()
    ? null
    : policy && "detailLink" in policy
      ? (policy as unknown as LinkChooser)
      : (() => {
          throw new CliExit("This chooser cannot pick drilldown detail links; use --link-text");
        })();
  const fieldJudge = options.fields?.length
    ? policy && "matchFields" in policy && "selectBlocks" in policy
      ? (policy as unknown as FieldJudge)
      : (() => {
          throw new CliExit("This chooser cannot match drilldown --fields");
        })()
    : null;
  const allowedDomains = state.explore?.allow ?? state.allowed_domains ?? null;
  return drilldownScan(
    browser,
    collector,
    state.plan,
    {
      match: options.match,
      linkText: options.linkText,
      linkChooser,
      fields: options.fields,
      fieldJudge,
      maxItems: options.maxItems,
      allowedDomains,
      loadMore: moreFn,
      attempt: state.plan.attempt,
    },
    recorder,
  );
}

async function commandDrilldown(args: Args): Promise<number> {
  const style = (args.format ?? "json") as DrilldownFormat;
  if (!FORMATS.includes(style)) throw new CliExit(`Unknown --format. Formats: ${FORMATS.join(", ")}`);
  const maxItems = args.max_items ?? DEFAULT_MAX_ITEMS;
  if (maxItems < 1 || maxItems > HARD_MAX_ITEMS) {
    throw new CliExit(`--max-items must be between 1 and ${HARD_MAX_ITEMS}`);
  }
  const fields = args.fields
    ? String(args.fields)
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
    : null;
  const outPath = args.out ? resolveOutPath(String(args.out)) : null;
  const state = requireSession();
  const needsPolicy = Boolean(args.match || args.more || fields || !args.link_text?.toString().trim());
  const policy = needsPolicy ? deps.policy() : null;
  const browser = await attach(state, null, browserView(state));
  const recorder = new Recorder(state.log);
  try {
    if (args.more) {
      // --more presses a control on the page: an operation of this attempt.
      state.attempt_unused = false;
      session.save(state);
    }
    const result = await runDrilldown(state, browser, policy, recorder, {
      match: args.match ?? null,
      linkText: args.link_text ?? null,
      fields,
      maxItems,
      more: args.more ?? null,
    });
    const rendered = formatDrilldown(result, style);
    if (outPath) {
      writeFileAtomic(outPath, `${rendered}\n`);
      print(`SAVED ${outPath} (format=${style}, visited=${result.visited}, matched=${result.matched})`);
    } else {
      print(rendered);
    }
    return OK;
  } catch (error) {
    if (error instanceof MutationUncertain) {
      print(`OUTCOME UNCERTAIN: ${error.message}. Run: webhand finish --status error`);
      return UNCERTAIN;
    }
    if (error instanceof PolicyError || error instanceof StalePage) {
      print(`DRILLDOWN FAILED: ${error.message}`);
      return FAILED;
    }
    throw error;
  } finally {
    await browser.close();
    recorder.close();
    await policy?.close?.();
  }
}

export const drilldownCommand: CommandDef = {
  name: "drilldown",
  session: "required",
  spec: () => ({
    help: "Read-only list-to-detail scan: filter rows and pick detail links with Jev, visit them, and return structured fields",
    options: [
      idOption(),
      {
        name: "match",
        type: "string",
        metavar: "CONDITION",
        help: "Filter list rows via parallel Jev classification before visiting detail pages",
      },
      {
        name: "link-text",
        type: "string",
        metavar: "TEXT",
        help: "Visit the first link of each row whose text contains this substring (such as Edit); Jev picks otherwise",
      },
      {
        name: "fields",
        type: "string",
        metavar: "A,B",
        help: "Keep only these comma-separated detail fields (such as Title,Rating); Jev matches them to the page's field names",
      },
      {
        name: "max-items",
        type: "int",
        default: DEFAULT_MAX_ITEMS,
        metavar: "N",
        help: `Maximum detail pages to visit (1-${HARD_MAX_ITEMS}, default ${DEFAULT_MAX_ITEMS})`,
      },
      {
        name: "more",
        type: "string",
        metavar: "CONTROL",
        help: "Press this pagination control (such as Next) to gather more list rows",
      },
      {
        name: "format",
        type: "string",
        default: "json",
        choices: [...FORMATS],
        help: "json (default), table, or markdown",
      },
      {
        name: "out",
        type: "string",
        metavar: "PATH",
        help: "Write output to a file under the current directory instead of stdout",
      },
    ],
  }),
  run: commandDrilldown,
};
