/** Tests never read the person's ~/.webhand and never call Jev. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { deps } from "../src/commands/context.ts";

const blockJev = () => {
  throw new Error("Tests never call Jev. Replace deps.policy");
};

deps.policy = blockJev;

const original = { ...deps };

beforeEach(() => {
  vi.stubEnv("WEBHAND_HOME", join(mkdtempSync(join(tmpdir(), "webhand-test-")), "workspace"));
  vi.stubEnv("WEBHAND_ENGINE", "chrome"); // Output must not depend on which browsers this machine has.
  vi.stubEnv("WEBHAND_SCREENSHOTS", ""); // A test turns capture on itself; the person's shell may have it on.
  deps.policy = blockJev;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Object.assign(deps, original);
});
