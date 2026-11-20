/** The `profile` command. */

import { statSync } from "node:fs";
import type { Args } from "../args.ts";
import { Browser } from "../browser.ts";
import { browserUrl, listProfiles, profileDir } from "../engines/chrome.ts";
import * as session from "../session.ts";

import { CliExit, FAILED, getContext, OK, print } from "./context.ts";
import { stopSignals } from "./finish.ts";
import { chooseChrome } from "./start.ts";

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Saved webhand profiles. A person signs in here directly; nothing is recorded or sent to Jev. */
export async function commandProfile(args: Args): Promise<number> {
  let chromeState: session.State;
  let chrome: string;
  try {
    let note: string | null;
    [chrome, note] = chooseChrome(args.chrome);
    if (note) print(`NOTE: ${note}`);
    if (args.action === "list") {
      const profiles = listProfiles(chrome);
      print(`SAVED PROFILES (${chrome}): ${profiles.length ? profiles.join(", ") : "(none)"}`);
      return OK;
    }
    if (!args.name) throw new CliExit(`profile ${args.action} needs a NAME`);
    const folder = profileDir(chrome, args.name);
    if (args.action === "delete") {
      if (!isDir(folder)) {
        print(`No saved profile ${args.name}`);
        return FAILED;
      }
      session.deleteProfile(folder);
      print(`DELETED profile ${args.name}`);
      return OK;
    }
    if (!args.url) throw new CliExit("profile login needs --url");
    if (session.active().some(([, state]) => state.saved_profile === args.name)) {
      throw new CliExit(`Profile ${args.name} is in use by an active run. Finish it first`);
    }
    chromeState = await session.startChrome({ headed: true, profile: args.name, chrome });
  } catch (error) {
    if (error instanceof session.SessionError) throw new CliExit(error.message);
    throw error;
  }
  const deadline = performance.now() + args.max_minutes * 60_000;
  const signals = stopSignals();
  try {
    await (await Browser.open(browserUrl(args.url, chrome), { port: chromeState.port })).close();
    // stdout is buffered for the handoff count, so the person sees this on stderr right away.
    getContext().err(`OPENED profile ${args.name}. Sign in in the Chrome window, then close the window\n`);
    await session.waitUntilClosed(chromeState, () => signals.stopped() || performance.now() >= deadline);
  } finally {
    signals.release();
    await session.stopChrome(chromeState);
  }
  print(`SAVED profile ${args.name}. Use it with: start --session profile:${args.name}`);
  return OK;
}
