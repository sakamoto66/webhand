/** The `record` command (also callable via the hidden `learn` alias). */

import type { Args } from "../args.ts";
import { Browser } from "../browser/index.ts";
import { quote } from "../core/format.ts";
import { gitState, Recorder } from "../core/metrics.ts";
import { browserUrl } from "../engines/chrome.ts";
import * as recorderMod from "../record.ts";
import * as runbook from "../storage/runbook/index.ts";
import * as session from "../storage/session.ts";
import { getContext, OK, print } from "./context.ts";
import { chromeOption } from "./options.ts";
import { chooseChrome, defaultLog } from "./shared.ts";
import { stopSignals } from "./signals.ts";
import type { CommandDef } from "./types.ts";

/** A person demonstrates a procedure. A long-running command, so run it in the background. */
async function commandRecord(args: Args): Promise<number> {
  const runbookFile = runbook.path(args.name, args.scope);
  const serviceFile = runbook.servicePath(String(args.name).split("/")[0], args.scope);
  const profile = session.parseSession(args.session);
  const [chrome, note] = chooseChrome(args.chrome);
  const stem = String(args.name).replaceAll("/", "-");
  const log = defaultLog(`record-${stem}`);
  getContext().log = log;
  const chromeState = await session.startChrome({ headed: !args.headless, profile, chrome });
  const deadline = performance.now() + args.max_minutes * 60_000;
  let browser: Browser | null = null;
  const recorder = new Recorder(log);
  const signals = stopSignals(); // Stopping the job still saves and closes.
  let counts: Record<string, number>;
  try {
    browser = await Browser.open(null, { port: chromeState.port });
    recorder.event("record_start", {
      name: args.name,
      url: args.url,
      scope: args.scope,
      chrome: browser.version,
      chrome_host: chrome,
      session: profile ? "profile" : "new",
      git: gitState(),
      started_at: new Date().toISOString(),
    });
    counts = await recorderMod.record(
      browser,
      browserUrl(args.url, chrome),
      recorder,
      () => signals.stopped() || performance.now() >= deadline,
    );
    recorder.event("record_end", { counts });
  } finally {
    signals.release();
    await browser?.close();
    await session.stopChrome(chromeState);
    recorder.close();
  }
  if (note) print(`NOTE: ${note}`);
  print(`RECORDED ${quote(counts)} log=${log}`);
  print(`WRITE THE RUNBOOK TO ${runbookFile}`);
  print(`WRITE THE SERVICE INFORMATION TO ${serviceFile}`);
  if (counts.unsupported) {
    print("WARNING: the record has operations the agent cannot reproduce. See its unsupported events");
  }
  return OK;
}

export const recordCommand: CommandDef = {
  name: "record",
  aliases: ["learn"],
  spec: () => ({
    help: "Record a person demonstrating a procedure",
    options: [
      { name: "name", type: "string", required: true, help: "Runbook name, such as hotel/filter" },
      { name: "url", type: "string", required: true },
      {
        name: "scope",
        type: "string",
        choices: ["project", "user"],
        default: "project",
        help: "Where the runbook belongs: this project's .webhand or your ~/.webhand",
      },
      { name: "session", type: "string", default: "new", help: "new or profile:NAME, to demonstrate signed in" },
      chromeOption(),
      { name: "max-minutes", type: "float", default: 30 },
      { name: "headless", type: "boolean", hidden: true },
    ],
  }),
  run: commandRecord,
};
