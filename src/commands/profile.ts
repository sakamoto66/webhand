/** The `profile` command. */

import type { Args } from "../args.ts";
import { Browser } from "../browser/index.ts";
import { isDir } from "../core/fs.ts";
import { browserUrl, listProfiles, profileDir } from "../engines/chrome.ts";
import * as session from "../storage/session.ts";
import { CliExit, FAILED, getContext, OK, print } from "./context.ts";
import { chromeOption } from "./options.ts";
import { chooseChrome } from "./shared.ts";
import { stopSignals } from "./signals.ts";
import type { CommandDef } from "./types.ts";

/** Saved webhand profiles. A person signs in here directly; nothing is recorded or sent to Jev. */
async function commandProfile(args: Args): Promise<number> {
  const [chrome, note] = chooseChrome(args.chrome);
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
  const chromeState = await session.startChrome({ headed: true, profile: args.name, chrome });
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

export const profileCommand: CommandDef = {
  name: "profile",
  spec: () => ({
    help: "Saved profiles: list, login NAME --url URL, delete NAME",
    options: [{ name: "url", type: "string" }, chromeOption(), { name: "max-minutes", type: "float", default: 15 }],
    positionals: [
      { name: "action", choices: ["list", "login", "delete"] },
      { name: "name", optional: true },
    ],
  }),
  run: commandProfile,
};
