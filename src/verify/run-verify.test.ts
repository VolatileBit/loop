import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanupTempDirs, makeTempRoot } from '../issues/test-helpers.js';
import { contentWidth } from '../logs/output-prefix.js';
import { announceVerifyStart, extractVerifyFailures, runVerifyCommand } from './run-verify.js';

afterEach(cleanupTempDirs);

describe('runVerifyCommand', () => {
  it('announces verification, emits heartbeats, reports duration, and captures output', async () => {
    const root = makeTempRoot('loop-verify-');
    const logPath = path.join(root, 'verify.log');
    let output = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      output += `${args.join(' ')}\n`;
    });

    let result;
    try {
      result = await runVerifyCommand(
        `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('verified'), 50)"`,
        root,
        logPath,
        {
          stageLabel: 'PRD-011/issue-01-verify',
          heartbeatIntervalMs: 10,
        },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(result.ok).toBe(true);
    expect(output).toContain('[01|verify] starting verification');
    expect(output).toContain('[01|verify] verification running…');
    expect(output).toMatch(/\[01\|verify] verification passed \(.+\)/);
    expect(readFileSync(logPath, 'utf8')).toContain('verified');
  });
});

describe('announceVerifyStart', () => {
  function announced(cmd: string): string[] {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      announceVerifyStart('[01|verify]', cmd);
      return log.mock.calls.map((call) => String(call[0]));
    } finally {
      log.mockRestore();
    }
  }

  it('keeps a short command on one line', () => {
    expect(announced('npm test')).toEqual(['[01|verify] starting verification: npm test']);
  });

  it('wraps a long command inside the line instead of losing its tail', () => {
    const long = `pnpm nx run-many -t test --projects=${'pkg-a '.repeat(60)}`;
    const lines = announced(long);

    // Which packages a gate covers is at the *end* of a monorepo command, so a
    // cut there hides exactly what the reader came for.
    expect(lines.join(' ')).toContain('pkg-a');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(contentWidth(''));
  });

  it('hangs continuations under the command, not under the prefix', () => {
    const lines = announced(`pnpm nx run-many -t test --projects=${'pkg-a '.repeat(60)}`);
    const column = lines[0]!.indexOf('pnpm');
    for (const line of lines.slice(1)) expect(line.search(/\S/)).toBe(column);
  });
});

describe('extractVerifyFailures', () => {
  it('pulls vitest FAIL lines and error summaries from verify output', () => {
    const output = `
 FAIL  packages/orchestrator/src/merge-on-review-pass.test.ts > merge on review pass > completes the task
MongoServerError: E11000 duplicate key error collection: pw_merge_review.tasks
 Test Files  1 failed | 79 passed (80)
      Tests  1 failed | 341 passed (344)
`;
    const failures = extractVerifyFailures(output);
    expect(failures.some((line) => line.includes('FAIL  packages/orchestrator'))).toBe(true);
    expect(failures.some((line) => line.includes('MongoServerError'))).toBe(true);
    expect(failures.some((line) => line.includes('Test Files'))).toBe(true);
  });

  it('deduplicates repeated failure lines and strips ANSI codes', () => {
    const red = '\u001b[31m';
    const reset = '\u001b[0m';
    const output = [
      ` FAIL  packages/foo/a.test.ts > case`,
      `${red} FAIL  packages/foo/a.test.ts > case${reset}`,
      ` × should work`,
    ].join('\n');
    const failures = extractVerifyFailures(output);
    expect(failures).toEqual(['FAIL  packages/foo/a.test.ts > case', '× should work']);
  });

  it('returns an empty list for passing output', () => {
    expect(extractVerifyFailures('Test Files  80 passed (80)\nTests  344 passed (344)\n')).toEqual([]);
  });
});
