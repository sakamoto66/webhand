/** Pre-authentication strategies (header vs form) run before HAR recording starts. */

import { chromium, type Page } from "playwright-core";
import { CliExit } from "../../src/commands/context.ts";
import type * as session from "../../src/storage/session.ts";
import type { AutoLoginTarget } from "./config.ts";

function normalizeLoginUrl(url: string): string {
  return url.split(/[?#]/)[0].replace(/\/+$/, "");
}

async function loginByHeader(page: Page, target: Extract<AutoLoginTarget, { mode: "header" }>): Promise<void> {
  await page.setExtraHTTPHeaders({ [target.header.name]: target.header.value });
  await page.goto(target.url, { waitUntil: "domcontentloaded" });
}

async function loginByForm(page: Page, target: Extract<AutoLoginTarget, { mode: "form" }>): Promise<void> {
  await page.goto(target.loginUrl, { waitUntil: "domcontentloaded" });
  await page.locator(target.userSelector).first().fill(target.user);
  await page.locator(target.passwordSelector).first().fill(target.password);
  const loginNorm = normalizeLoginUrl(target.loginUrl);
  const [postResponse] = await Promise.all([
    page.waitForResponse((res) => res.request().method() === "POST", { timeout: 15_000 }).catch(() => null),
    page.locator(target.submitSelector).first().click(),
  ]);
  await page.waitForLoadState("load").catch(() => {});
  if (normalizeLoginUrl(page.url()) === loginNorm) {
    await page
      .waitForURL((url) => normalizeLoginUrl(url.href) !== loginNorm, { waitUntil: "load", timeout: 2_000 })
      .catch(() => {});
  }
  if (
    normalizeLoginUrl(page.url()) === loginNorm &&
    (await page
      .locator(target.passwordSelector)
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    const postStatus = postResponse ? String(postResponse.status()) : "no-response";
    throw new CliExit(
      `Form pre-login failed for ${target.site} at ${target.loginUrl} (post=${postStatus}, final=${normalizeLoginUrl(page.url())})`,
    );
  }
}

/**
 * Authenticates each configured WebArena test-environment site in Chrome BEFORE HAR recording
 * begins, so session cookies are stored in Chrome's cookie jar while credentials never appear
 * in network.har, CLI arguments, host agent, or Jev.
 */
export async function preAuthenticate(chromeState: session.State, targets: AutoLoginTarget[]): Promise<void> {
  if (!targets.length || !chromeState.port) return;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chromeState.port}`);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    for (const target of targets) {
      const page = await context.newPage();
      try {
        if (target.mode === "header") await loginByHeader(page, target);
        else await loginByForm(page, target);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}
