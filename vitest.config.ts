import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// Real Chrome processes: cap parallelism on CI runners so concurrent browsers do not starve timers or CDP.
const maxWorkers = Math.max(1, Math.min(process.env.CI ? 3 : 6, availableParallelism()));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    fileParallelism: true,
    maxWorkers,
    // Fixtures settle fast; the tests of settling itself set the real 150 ms back. A browser may start slowly when
    // the machine runs several suites (the default is 15 s).
    env: { WEBHAND_SETTLE_QUIET_MS: "40", WEBHAND_STARTUP_MS: "45000" },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      // Below these, vitest --coverage exits non-zero and CI fails.
      thresholds: { lines: 70, statements: 70, functions: 70, branches: 70 },
    },
  },
});
