/** What an engine is: how it starts, stops, attaches, and what capabilities it supports. One file per engine implements this. */

import type { ViewChoice } from "../browser/index.ts";
import { SessionError } from "../core/errors.ts";
import type { Driver } from "../ipc/remote.ts";
import type { State } from "../storage/session.ts";

export interface StartOptions {
  headed: boolean;
  profile: string | null;
  /** Where Chrome runs: "linux" or "windows". Only Chrome has the choice. */
  chrome: string;
  /** How long the browser may take to start. */
  startupMs: number;
}

interface EngineCapabilities {
  /** Supports --file uploads and --download-dir on the local machine. */
  localFiles: boolean;
  /** Supports --har CDP network recording. */
  har: boolean;
  /** Supports --explore (local Linux Chrome network routing and console/error collection). */
  explore: boolean;
  /** Can keep a run inside a service's allowed_domains. A run that has them is refused without it. */
  allowedDomains: boolean;
}

export interface Engine {
  /** The --engine value. */
  id: string;
  /** How output names it ("Lightpanda"). null reads as "linux Chrome" / "windows Chrome". */
  label: string | null;
  capabilities: EngineCapabilities;
  start(options: StartOptions): Promise<State>;
  stop(state: State): Promise<void>;
  /**
   * Connects to an already started session browser of this engine. A local Chrome that cannot be connected to because
   * of tabs that never loaded closes them and calls onStuckTabsClosed.
   */
  attach(
    state: State,
    url: string | null,
    view?: ViewChoice | null,
    onStuckTabsClosed?: (count: number) => void,
  ): Promise<Driver>;
  /** Printed by `start`. */
  notes?: { start?: string; auth?: string };
  /** An engine held by a daemon (see ipc/daemon.ts): its own command line, and whether the page needs snapshot compat. */
  serve?: { arguments(port: number): string[]; compat: boolean };
}

/** What a refusal over allowed_domains tells Claude to do instead. */
export const ENFORCING_ENGINES = "Use --engine chrome, headless-shell or lightpanda";

/** A session saved with allowed_domains is not attached by an engine that cannot enforce them. */
export function rejectAllowedDomains(label: string, state: State): void {
  if (state.allowed_domains?.length) {
    throw new SessionError(`${label} cannot enforce allowed_domains. ${ENFORCING_ENGINES}`);
  }
}

/** Engines without a window have nothing to sign in in, and no saved profile: fail rather than drop the ask quietly. */
export function rejectWindowAndProfile(name: string, options: { headed: boolean; profile: string | null }): void {
  if (options.profile) throw new SessionError(`${name} has no saved profile. Use --session new`);
  if (options.headed) throw new SessionError(`${name} has no window, so --headed is not available`);
}
