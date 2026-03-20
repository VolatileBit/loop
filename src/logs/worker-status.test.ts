import { describe, expect, it } from 'vitest';

import { formatWorkerElapsed, formatWorkerStatusBlock } from './worker-status.js';

describe('formatWorkerElapsed', () => {
  it('renders minutes and zero-padded seconds', () => {
    expect(formatWorkerElapsed(48_000)).toBe('0m48s');
    expect(formatWorkerElapsed(134_000)).toBe('2m14s');
    expect(formatWorkerElapsed(62_000)).toBe('1m02s');
  });

  it('includes hours when elapsed exceeds an hour', () => {
    expect(formatWorkerElapsed(3_734_000)).toBe('1h02m14s');
  });

  it('clamps negative input to zero', () => {
    expect(formatWorkerElapsed(-5)).toBe('0m00s');
  });
});

describe('formatWorkerStatusBlock', () => {
  it('renders the header plus one aligned line per active worker', () => {
    const block = formatWorkerStatusBlock(
      [
        {
          qualifiedId: 'PRD-006/issue-07',
          stage: 'implement',
          elapsedMs: 134_000,
          logPath: '.loop/runs/PRD-006/issue-07-implement.log',
        },
        {
          qualifiedId: 'PRD-006/issue-09',
          stage: 'verify-fix-1',
          elapsedMs: 48_000,
          logPath: '.loop/runs/PRD-006/issue-09-verify-fix-1.log',
        },
        {
          qualifiedId: 'PRD-004/issue-02',
          stage: 'review',
          elapsedMs: 62_000,
          logPath: '.loop/runs/PRD-004/issue-02-review.log',
        },
      ],
      5,
    );

    const lines = block.split('\n');
    expect(lines[0]).toBe('[loop] 3/5 workers active');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('  PRD-006/issue-07  implement     2m14s  log: .loop/runs/PRD-006/issue-07-implement.log');
    expect(lines[2]).toBe('  PRD-006/issue-09  verify-fix-1  0m48s  log: .loop/runs/PRD-006/issue-09-verify-fix-1.log');
    expect(lines[3]).toBe('  PRD-004/issue-02  review        1m02s  log: .loop/runs/PRD-004/issue-02-review.log');
  });

  it('aligns columns across workers with different id and stage widths', () => {
    const block = formatWorkerStatusBlock(
      [
        { qualifiedId: 'a/1', stage: 'implement', elapsedMs: 0, logPath: 'log-a' },
        { qualifiedId: 'longer-project/issue-10', stage: 'review-fix-2', elapsedMs: 60_000, logPath: 'log-b' },
      ],
      2,
    );

    const lines = block.split('\n').slice(1);
    const logColumns = lines.map((line) => line.indexOf('log: '));
    expect(logColumns[0]).toBe(logColumns[1]);
    expect(logColumns[0]).toBeGreaterThan(0);
  });

  it('renders only the header when no workers are active', () => {
    expect(formatWorkerStatusBlock([], 3)).toBe('[loop] 0/3 workers active');
  });
});
