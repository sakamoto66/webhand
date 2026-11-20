/**
 * The engines --engine can name, in one table. How an engine starts lives in session.ts (local Chrome, headless
 * shell, daemon-held engines) and browser-run.ts (Cloudflare); this says only what each one is.
 */

import { SessionError } from "./errors.ts";

/** local: a process of this machine. daemon: runs as `serve` behind a daemon (no pages survive a CDP disconnect). cloud: Cloudflare. */
type Kind = "chrome" | "shell" | "daemon" | "cloud";

const ENGINES: Record<string, { kind: Kind; name?: string }> = {
  chrome: { kind: "chrome" },
  "headless-shell": { kind: "shell", name: "Chrome headless shell" },
  lightpanda: { kind: "daemon", name: "Lightpanda" },
  obscura: { kind: "daemon", name: "Obscura" },
  "browser-run": { kind: "cloud", name: "Cloudflare Browser Run" },
  kitesurf: { kind: "cloud", name: "Cloudflare Browser Run (Kitesurf)" },
};

/** What runs the browser (--engine). auto is the default: see session.chooseEngine. */
export const ENGINE_CHOICES = ["auto", ...Object.keys(ENGINES)];

/** How a session's browser reads in output: "Lightpanda", or "linux Chrome". */
export function hostName(engine: string, chrome: string): string {
  return ENGINES[engine]?.name ?? `${chrome} Chrome`;
}

/** Engines with a daemon (Lightpanda, Obscura). */
export function isDaemon(engine: string | undefined): boolean {
  return ENGINES[engine ?? ""]?.kind === "daemon";
}

/** Engines on Cloudflare Browser Run: its Chromium (browser-run) and its stateless agent browser (kitesurf). */
export function isCloud(engine: string | undefined): boolean {
  return ENGINES[engine ?? ""]?.kind === "cloud";
}

/** Every engine but Chrome has no window to sign in in and no saved profile: fail rather than drop the ask quietly. */
export function rejectWindowAndProfile(engine: string, options: { headed: boolean; profile: string | null }): void {
  const name = hostName(engine, "linux");
  const the = engine === "headless-shell" ? "The headless shell" : name;
  if (options.profile) throw new SessionError(`${the} has no saved profile. Use --session new`);
  if (options.headed) throw new SessionError(`${the} has no window, so --headed is not available`);
}
