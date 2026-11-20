/** What an engine is: how it starts and stops, and what it says to the person. One file per engine implements this. */

import { SessionError } from "../errors.ts";
import type { State } from "../session.ts";

export interface StartOptions {
  headed: boolean;
  profile: string | null;
  /** Where Chrome runs: "linux" or "windows". Only Chrome has the choice. */
  chrome: string;
  /** How long the browser may take to start. */
  startupMs: number;
}

export interface Engine {
  /** The --engine value. */
  id: string;
  /** How output names it ("Lightpanda"). null reads as "linux Chrome" / "windows Chrome". */
  label: string | null;
  start(options: StartOptions): Promise<State>;
  stop(state: State): Promise<void>;
  /** Printed by `start`. */
  notes?: { start?: string; auth?: string };
  /** An engine held by a daemon (see daemon.ts): its own command line, and whether the page needs snapshot compat. */
  serve?: { arguments(port: number): string[]; compat: boolean };
}

/** Engines without a window have nothing to sign in in, and no saved profile: fail rather than drop the ask quietly. */
export function rejectWindowAndProfile(name: string, options: { headed: boolean; profile: string | null }): void {
  if (options.profile) throw new SessionError(`${name} has no saved profile. Use --session new`);
  if (options.headed) throw new SessionError(`${name} has no window, so --headed is not available`);
}
