/** chrome-headless-shell: Chrome without the browser UI, at about half the memory. No window and no saved profile. */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionError } from "../core/errors.ts";
import { attachLocal, launchChrome, stopLocal } from "./chrome.ts";
import { isFile, which } from "./process.ts";
import { type Engine, rejectWindowAndProfile } from "./types.ts";

/** WEBHAND_HEADLESS_SHELL, PATH, or the newest one in Playwright's browser cache. Tests replace this. */
export const shellProbe = {
  binary(): string | null {
    const given = process.env.WEBHAND_HEADLESS_SHELL;
    if (given && isFile(given)) return given;
    const onPath = which("chrome-headless-shell");
    if (onPath) return onPath;
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
    let builds: string[] = [];
    try {
      builds = readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-"));
    } catch {
      return null;
    }
    builds.sort((a, b) => Number.parseInt(b.split("-")[1], 10) - Number.parseInt(a.split("-")[1], 10));
    for (const build of builds) {
      const folder = join(cache, build);
      for (const inner of readdirSync(folder).filter((name) => name.startsWith("chrome-headless-shell"))) {
        const binary = join(folder, inner, "chrome-headless-shell");
        if (isFile(binary)) return binary;
      }
    }
    return null;
  },
};

export const headlessShell: Engine = {
  id: "headless-shell",
  label: "Chrome headless shell",
  capabilities: { localFiles: true, har: true, explore: true },
  async start(options) {
    // No window to sign in in, and a profile made by Chrome may be newer than this build.
    rejectWindowAndProfile("The headless shell", options);
    if (options.chrome === "windows") throw new SessionError("The headless shell runs on Linux only");
    const executable = shellProbe.binary();
    if (!executable) throw new SessionError("chrome-headless-shell was not found (set WEBHAND_HEADLESS_SHELL)");
    return launchChrome(executable, { ...options, shell: true });
  },
  stop: stopLocal,
  attach: attachLocal,
};
