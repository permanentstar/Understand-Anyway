import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // src/ holds vitest suites. scripts/ holds node:assert scripts that are
    // exercised via `node` in the root `test:scripts` runner, not vitest.
    include: ["src/**/*.test.ts"],
  },
});
