/** The `learn` command. */

import type { Args } from "../args.ts";
import { Browser } from "../browser.ts";
import { browserUrl } from "../engines/chrome.ts";
import { quote } from "../format.ts";
import * as learn from "../learn.ts";
import { gitState, Recorder } from "../metrics.ts";
import * as runbook from "../runbook.ts";
import * as session from "../session.ts";

import { CliExit, getContext, OK, print } from "./context.ts";
import { stopSignals } from "./finish.ts";
import { defaultLog } from "./shared.ts";
import { chooseChrome } from "./start.ts";

/** A person demonstrates a procedure. A long-running command, so run it in the background. */
export async function commandLearn(args: Args): Promise<number> {
  let profile: string | null;
  let chrome: string;
  let note: string | null;
  let runbookFile: string;
  let serviceFile: string | null;
  try {
    runbookFile = runbook.path(args.name, args.scope);
    const parts = String(args.name).split("/");
    serviceFile = parts.length > 1 ? runbook.servicePath(parts[0], args.scope) : null;
    profile = session.parseSession(args.session);
    [chrome, note] = chooseChrome(args.chrome);
  } catch (error) {
    if (error instanceof runbook.RunbookError || error instanceof session.SessionError) {
      throw new CliExit(error.message);
    }
    throw error;
  }
  const stem = String(args.name).replaceAll("/", "-");
  const log = defaultLog(`learn-${stem}`);
  getContext().log = log;
  let chromeState: session.State;
  try {
    chromeState = await session.startChrome({ headed: !args.headless, profile, chrome });
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
  const deadline = performance.now() + args.max_minutes * 60_000;
  let browser: Browser | null = null;
  const recorder = new Recorder(log);
  const signals = stopSignals(); // Stopping the job still saves and closes.
  let counts: Record<string, number>;
  try {
    browser = await Browser.open(null, { port: chromeState.port });
    recorder.event("learn_start", {
      name: args.name,
      url: args.url,
      scope: args.scope,
      chrome: browser.version,
      chrome_host: chrome,
      session: profile ? "profile" : "new",
      git: gitState(),
      started_at: new Date().toISOString(),
    });
    counts = await learn.record(
      browser,
      browserUrl(args.url, chrome),
      recorder,
      () => signals.stopped() || performance.now() >= deadline,
    );
    recorder.event("learn_end", { counts });
  } finally {
    signals.release();
    await browser?.close();
    await session.stopChrome(chromeState);
    recorder.close();
  }
  if (note) print(`NOTE: ${note}`);
  print(`RECORDED ${quote(counts)} log=${log}`);
  print(`WRITE THE RUNBOOK TO ${runbookFile}`);
  if (serviceFile) print(`WRITE THE SERVICE INFORMATION TO ${serviceFile}`);
  if (counts.unsupported) {
    print("WARNING: the record has operations the agent cannot reproduce. See its unsupported events");
  }
  return OK;
}
