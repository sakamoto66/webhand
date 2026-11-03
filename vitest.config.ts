import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Real Chrome processes and one session file per test: run files one at a time.
    pool: "forks",
    fileParallelism: false,
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
