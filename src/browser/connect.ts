/** Connects to a local browser over its debugging port, closing tabs that never loaded when they block it. */

import { type Browser, chromium, errors } from "playwright-core";

/** How long one connection attempt may take, which is also how long a tab may take to load before it can be closed. Tests shorten it. */
export const connectLimit = { ms: 30_000 };
const ENDPOINT_MS = 5000;

/**
 * Closes the page targets with no URL: those whose first document never arrived. A loaded tab, a blank one included,
 * has a URL, so it is left alone. Returns how many were closed.
 */
async function closeUnloadedTabs(base: string): Promise<number> {
  const request = (path: string) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(ENDPOINT_MS) });
  const targets = (await (await request("/json/list")).json()) as { id: string; type: string; url: string }[];
  let closed = 0;
  for (const target of targets) {
    if (target.type !== "page" || target.url !== "") continue;
    if ((await request(`/json/close/${encodeURIComponent(target.id)}`)).ok) closed += 1;
  }
  return closed;
}

/**
 * Playwright's connection waits until every tab has its first document, so a tab that gets none (no answer, a 204)
 * times it out. With onClosed, such tabs are then closed and the connection is made once more. Only the connection is
 * made again: no command has done anything in the browser yet.
 */
export async function connectLocal(port: number, onClosed?: (count: number) => void): Promise<Browser> {
  const base = `http://127.0.0.1:${port}`;
  const connect = () => chromium.connectOverCDP(base, { timeout: connectLimit.ms });
  try {
    return await connect();
  } catch (error) {
    if (!onClosed || !(error instanceof errors.TimeoutError)) throw error;
    const closed = await closeUnloadedTabs(base).catch(() => 0);
    if (closed === 0) throw error;
    onClosed(closed);
    return await connect();
  }
}
