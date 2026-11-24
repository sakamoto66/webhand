/** Every engine --engine can name, one file each. session.ts starts and stops them through this table. */

import { browserRun } from "./browser-run.ts";
import { chrome } from "./chrome.ts";
import { headlessShell, shellProbe } from "./headless-shell.ts";
import { kitesurf } from "./kitesurf.ts";
import { lightpanda } from "./lightpanda.ts";
import { obscura } from "./obscura.ts";
import type { Engine } from "./types.ts";

const ENGINES: Engine[] = [chrome, headlessShell, lightpanda, obscura, browserRun, kitesurf];
const BY_ID = new Map(ENGINES.map((engine) => [engine.id, engine]));

/** What runs the browser (--engine). auto is the default: see chooseEngine. */
export const ENGINE_CHOICES = ["auto", ...BY_ID.keys()];

/** The engine named in the session state; a state without one is Chrome. */
export function engineFor(id: string | undefined): Engine {
  const found = BY_ID.get(id ?? "chrome");
  if (!found) throw new Error(`Unknown engine ${id}`);
  return found;
}

/** How a session's browser reads in output: "Lightpanda", or "linux Chrome". */
export function hostName(id: string, chromeHost: string): string {
  return BY_ID.get(id)?.label ?? `${chromeHost} Chrome`;
}

/**
 * What auto means. A run that needs no window and no saved profile uses the headless shell when one is installed:
 * half the memory, the same results (see docs/research/research-plan.md). A window or a profile keeps Chrome, and so does
 * asking for the Windows Chrome (--chrome windows; --chrome auto only says "use it if you can", and a headless run
 * gains nothing from it). A missing shell falls back to Chrome quietly: that is what the run used before. A named
 * engine is taken as asked. `chrome` is what --chrome asked for, not where it resolved to.
 */
export function chooseEngine(
  engine: string,
  options: { headed: boolean; profile: string | null; chrome: string },
): string {
  if (engine !== "auto") return engine;
  if (options.headed || options.profile || options.chrome === "windows") return "chrome";
  return shellProbe.binary() ? "headless-shell" : "chrome";
}
