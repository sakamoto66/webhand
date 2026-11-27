/** Browser Run on Cloudflare: a Chrome reached over CDP with the account's API key. Nothing runs locally. */

import { Browser } from "../browser/index.ts";
import { SessionError } from "../core/errors.ts";
import type { State } from "../storage/session.ts";
import { type Engine, rejectAllowedDomains, rejectWindowAndProfile, type StartOptions } from "./types.ts";

const API = "https://api.cloudflare.com/client/v4/accounts";

/** Where the account and key come from: the environment only, never a file or the session state. */
function account(): { id: string; token: string } {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!id || !token) {
    throw new SessionError(
      "Browser Run needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN set as environment variables",
    );
  }
  return { id: encodeURIComponent(id), token };
}

/** The header every Browser Run connection carries. Built from the environment on each use, so the key is never saved. */
export function browserRunHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${account().token}` };
}

/**
 * Browser Run has no window and no saved profile, and what a run opens (pages, a restored login) is sent to
 * Cloudflare. Nothing runs locally, so the state has no pid and no folder. `query` picks the browser and its options.
 */
export function cloudflareEngine(spec: { id: string; label: string; query: string; notes?: Engine["notes"] }): Engine {
  return {
    id: spec.id,
    label: spec.label,
    capabilities: { localFiles: false, har: false, explore: false, allowedDomains: false },
    notes: spec.notes,
    async start(options: StartOptions): Promise<State> {
      rejectWindowAndProfile(spec.label, options);
      const { id } = account();
      let response: Response;
      try {
        response = await fetch(`${API}/${id}/browser-run/devtools/browser?${spec.query}`, {
          method: "POST",
          headers: browserRunHeaders(),
          signal: AbortSignal.timeout(options.startupMs),
        });
      } catch {
        throw new SessionError(`${spec.label} did not start: the API could not be reached`);
      }
      if (!response.ok) {
        await response.body?.cancel();
        const wait =
          response.status === 429
            ? ` Cloudflare is limiting new sessions (Workers Free: one every 20 seconds); wait${response.headers.get("retry-after") ? ` ${response.headers.get("retry-after")} seconds` : ""} and run start again.`
            : "";
        throw new SessionError(`${spec.label} did not start: the API answered ${response.status}.${wait}`);
      }
      const body = (await response.json().catch(() => null)) as {
        sessionId?: unknown;
        webSocketDebuggerUrl?: unknown;
      } | null;
      if (typeof body?.sessionId !== "string" || typeof body.webSocketDebuggerUrl !== "string") {
        throw new SessionError(`${spec.label} did not start: the API gave no session`);
      }
      return {
        profile: "",
        saved_profile: null,
        chrome: "linux",
        engine: spec.id,
        headed: false,
        session_id: body.sessionId,
        cdp: body.webSocketDebuggerUrl,
      };
    },
    /** Failing to end the session is not an error: it closes by itself when idle. */
    async stop(state: State): Promise<void> {
      try {
        const { id } = account();
        const response = await fetch(
          `${API}/${id}/browser-run/devtools/browser/${encodeURIComponent(state.session_id)}`,
          {
            method: "DELETE",
            headers: browserRunHeaders(),
            signal: AbortSignal.timeout(5000),
          },
        );
        await response.body?.cancel();
      } catch {
        // Gone already, or the key is not set here: it closes after its idle time.
      }
    },
    async attach(state, url, view) {
      rejectAllowedDomains(spec.label, state);
      return await Browser.open(url, { endpoint: { url: state.cdp, headers: browserRunHeaders() }, view });
    },
  };
}
