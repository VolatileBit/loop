import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Console assertions must not depend on whether the suite ran in a terminal.
    env: { NO_COLOR: '1' },
  },
});
