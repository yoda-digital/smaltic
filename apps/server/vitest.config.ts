import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    // Keep test output pristine: the request logger is silenced unless a test supplies its own logger, and a test
    // secret avoids the dev-default warning (tests of that warning pass their own env to loadConfig).
    env: { SMALTIC_LOG_LEVEL: "silent", SMALTIC_SECRET: "test-secret-0123456789abcdef0123456789" },
  },
});
