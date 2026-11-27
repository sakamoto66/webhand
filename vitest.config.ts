import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// Real Chrome processes: cap parallelism on CI runners so concurrent browsers do not starve timers or CDP.
const maxWorkers = Math.max(1, Math.min(process.env.CI ? 3 : 6, availableParallelism()));

export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    fileParallelism: true,
    maxWorkers,
    // Fixtures settle fast; the tests of settling itself set the real 150 ms back. A browser may start slowly when
    // the machine runs several suites (the default is 15 s).
    env: {
      WEBHAND_SETTLE_QUIET_MS: "40",
      WEBHAND_STARTUP_MS: "45000",
      // Prevent parent shell API tokens from leaking into tests; tests that need a fake key stub it explicitly.
      TYPESAFE_API_KEY: "",
      CLOUDFLARE_API_TOKEN: "",
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["tests/browser/**/*.test.ts"],
        },
      },
    ],
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
