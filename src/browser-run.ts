/** Browser Run on Cloudflare: a Chrome reached over CDP with the account's API key. Nothing runs locally. */

import { hostName, rejectWindowAndProfile } from "./engines.ts";
import { SessionError } from "./errors.ts";
import type { State } from "./session.ts";

const BROWSER_RUN_API = "https://api.cloudflare.com/client/v4/accounts";
/** The longest idle time Browser Run allows (20 minutes), so a session outlives the gaps between commands. */
const BROWSER_RUN_KEEP_ALIVE_MS = 1_200_000;

/** Where Browser Run's account and key come from: the environment only, never a file or the session state. */
function browserRunAccount(): { id: string; token: string } {
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
  return { Authorization: `Bearer ${browserRunAccount().token}` };
}

/**
 * Browser Run is a Chrome on Cloudflare's network, reached over CDP like the session Chrome. It has no window and no
 * saved profile, and what a run opens (pages, a restored login) is sent to Cloudflare. Nothing runs locally, so the state
 * has no pid and no folder.
 */
export async function startBrowserRun(
  engine: string,
  options: { headed: boolean; profile: string | null },
  startupMs: number,
): Promise<State> {
  const name = hostName(engine, "linux");
  rejectWindowAndProfile(engine, options);
  const { id } = browserRunAccount();
  // Kitesurf takes no keep_alive (Cloudflare: it cannot be combined), so its session closes after the default idle time.
  const query = engine === "kitesurf" ? "browser=kitesurf" : `keep_alive=${BROWSER_RUN_KEEP_ALIVE_MS}`;
  let response: Response;
  try {
    response = await fetch(`${BROWSER_RUN_API}/${id}/browser-run/devtools/browser?${query}`, {
      method: "POST",
      headers: browserRunHeaders(),
      signal: AbortSignal.timeout(startupMs),
    });
  } catch {
    throw new SessionError(`${name} did not start: the API could not be reached`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const wait =
      response.status === 429
        ? ` Cloudflare is limiting new sessions (Workers Free: one every 20 seconds); wait${response.headers.get("retry-after") ? ` ${response.headers.get("retry-after")} seconds` : ""} and run start again.`
        : "";
    throw new SessionError(`${name} did not start: the API answered ${response.status}.${wait}`);
  }
  const body = (await response.json().catch(() => null)) as {
    sessionId?: unknown;
    webSocketDebuggerUrl?: unknown;
  } | null;
  if (typeof body?.sessionId !== "string" || typeof body.webSocketDebuggerUrl !== "string") {
    throw new SessionError(`${name} did not start: the API gave no session`);
  }
  return {
    profile: "",
    saved_profile: null,
    chrome: "linux",
    engine,
    headed: false,
    session_id: body.sessionId,
    cdp: body.webSocketDebuggerUrl,
  };
}

/** Ends the Browser Run session. Failing to is not an error: it closes by itself when idle. */
export async function stopBrowserRun(state: State): Promise<void> {
  try {
    const { id } = browserRunAccount();
    const response = await fetch(
      `${BROWSER_RUN_API}/${id}/browser-run/devtools/browser/${encodeURIComponent(state.session_id)}`,
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
}
