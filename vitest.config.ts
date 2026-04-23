import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The process pool can time out its task-update RPC while several of the
    // intentionally long pipeline suites finish together. Threads keep the
    // same per-file isolation without that process IPC failure mode.
    pool: 'threads',
    // Console assertions must not depend on whether the suite ran in a terminal.
    env: { NO_COLOR: '1' },
  },
});
