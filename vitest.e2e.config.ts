import { defineConfig } from 'vitest/config';

/**
 * Live E2E config (`npm run test:e2e`): spawns the real agent CLIs, so it is
 * never part of `npm test`. One file, sequential tests — the CLIs share auth
 * state and interleaved live sessions are miserable to debug.
 */
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    testTimeout: 15 * 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Seam assertions read loop's own output; styling must not depend on a TTY.
    env: { NO_COLOR: '1' },
  },
});
