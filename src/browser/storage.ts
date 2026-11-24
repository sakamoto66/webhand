/** Cookies and localStorage export/restore for `auth save` and `start --auth`. */

import type { BrowserContext, Page as PlaywrightPage } from "playwright-core";
import type { StorageState } from "../storage/auth.ts";

/**
 * The session's cookies and localStorage, to be saved as a login. Nothing on any page changes. Playwright only knows
 * the localStorage of pages it saw load, and each command is a new connection, so the sites of the open tabs are read
 * directly. A site the session visited and left is not in it.
 */
export async function readStorageState(context: BrowserContext, openTabs: PlaywrightPage[]): Promise<StorageState> {
  const state = await context.storageState();
  for (const page of openTabs) {
    let origin: string;
    try {
      origin = new URL(page.url()).origin;
    } catch {
      continue;
    }
    if (!/^https?:/.test(origin) || state.origins.some((known) => known.origin === origin)) continue;
    try {
      const items: { name: string; value: string }[] = await page.evaluate(() =>
        Object.entries(localStorage).map(([name, value]) => ({ name, value: String(value) })),
      );
      if (items.length) state.origins.push({ origin, localStorage: items });
    } catch {
      // A page that refuses storage (an opaque origin) has none to keep.
    }
  }
  return state;
}

/**
 * Signs this browser in with a saved state and opens url. Cookies go in before the page loads. localStorage can only
 * be written from a page of its own site, so it is set for the site of url and the page is loaded once more.
 * Returns the sites whose localStorage could not be restored.
 */
export async function restoreStorageState(
  context: BrowserContext,
  page: PlaywrightPage,
  evaluate: (expression: string) => Promise<unknown>,
  state: StorageState,
  url: string,
): Promise<string[]> {
  if (state.cookies.length) await context.addCookies(state.cookies);
  await page.goto(url, { waitUntil: "load" });
  const here = new URL(page.url()).origin;
  const items = state.origins.find((origin) => origin.origin === here)?.localStorage ?? [];
  if (items.length) {
    await evaluate(
      `(() => { for (const [k, v] of ${JSON.stringify(items.map((item) => [item.name, item.value]))}) localStorage.setItem(k, v); })()`,
    );
    await page.goto(url, { waitUntil: "load" });
  }
  return state.origins.filter((origin) => origin.origin !== here && origin.localStorage.length).map((o) => o.origin);
}
