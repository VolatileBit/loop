import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDirs, makeTempRoot } from '../issues/test-helpers.js';
import { invocationLogsDir, startInvocationLog } from './invocation-log.js';

afterEach(() => {
  cleanupTempDirs();
});

describe('startInvocationLog', () => {
  it('tees stdout and stderr to the log file with ANSI stripped, until stopped', () => {
    const root = makeTempRoot('loop-invlog-');
    // Constructed from local parts so the expected HH:MM:SS is timezone-independent.
    const stamped = new Date(2026, 6, 25, 10, 47, 12);
    const now = () => stamped;
    const { logPath, stop } = startInvocationLog(root, 'run', { now });
    try {
      // Written via the raw streams — the seam the tee wraps (vitest patches
      // console.* away from process.stdout, but production console.* lands here).
      process.stdout.write('[32mgreen[0m usage totals: $1.25\n');
      process.stderr.write('escalated: needs-human\n');
    } finally {
      stop();
    }
    process.stdout.write('after stop — not logged\n');

    const content = readFileSync(logPath, 'utf8');
    // The header keeps the full date the per-line stamps drop.
    expect(content).toContain('# loop run — started');
    expect(content).toMatch(/# loop run — started \d{4}-\d{2}-\d{2}T/);
    expect(content).toContain('10:47:12 green usage totals: $1.25');
    expect(content).not.toContain('[32m');
    expect(content).toContain('10:47:12 escalated: needs-human');
    expect(content).not.toContain('after stop');
    expect(path.dirname(logPath)).toBe(invocationLogsDir(root));
    expect(readdirSync(invocationLogsDir(root))).toHaveLength(1);
  });
});
