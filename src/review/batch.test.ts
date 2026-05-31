import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDirs, makeIssue, makeTempRoot } from '../issues/test-helpers.js';
import { compareQualifiedIds, resolveReviewTargets } from './batch.js';

afterEach(() => {
  cleanupTempDirs();
});

const issues = [
  makeIssue({ id: 'issue-01', project: 'PRD-001' }),
  makeIssue({ id: 'issue-02', project: 'PRD-001' }),
  makeIssue({ id: 'issue-10', project: 'PRD-002' }),
  makeIssue({ id: 'issue-11', project: 'PRD-002' }),
];

describe('compareQualifiedIds', () => {
  it('sorts qualified ids numerically', () => {
    expect(compareQualifiedIds('PRD-001/issue-09', 'PRD-002/issue-01')).toBeLessThan(0);
    expect(compareQualifiedIds('PRD-002/issue-10', 'PRD-002/issue-9')).toBeGreaterThan(0);
  });
});

describe('resolveReviewTargets', () => {
  it('includes all issues up to an --until qualified id', () => {
    const targets = resolveReviewTargets(issues, { until: 'PRD-002/issue-10' });
    expect(targets.map((item) => item.qualifiedId)).toEqual([
      'PRD-001/issue-01',
      'PRD-001/issue-02',
      'PRD-002/issue-10',
    ]);
  });

  it('resolves explicit --ids in sorted order, accepting bare-id shorthand', () => {
    const targets = resolveReviewTargets(issues, { ids: ['PRD-002/issue-10', 'issue-01'] });
    expect(targets.map((item) => item.qualifiedId)).toEqual(['PRD-001/issue-01', 'PRD-002/issue-10']);
  });

  it('accepts unambiguous bare-id shorthand for --until', () => {
    const targets = resolveReviewTargets(issues, { until: 'issue-10' });
    expect(targets.map((item) => item.qualifiedId)).toEqual([
      'PRD-001/issue-01',
      'PRD-001/issue-02',
      'PRD-002/issue-10',
    ]);
  });

  it('rejects an ambiguous bare-id shorthand, listing candidate projects', () => {
    const ambiguous = [
      makeIssue({ id: 'issue-01', project: 'PRD-001' }),
      makeIssue({ id: 'issue-01', project: 'PRD-002' }),
    ];
    expect(() => resolveReviewTargets(ambiguous, { ids: ['issue-01'] })).toThrowError(/ambiguous/);
  });

  it('rejects unknown issue references', () => {
    expect(() => resolveReviewTargets(issues, { ids: ['issue-99'] })).toThrowError(/Unknown issue reference/);
  });

  it('reads references from a file, ignoring comments and blanks', () => {
    const dir = makeTempRoot('loop-batch-');
    const file = path.join(dir, 'targets.txt');
    writeFileSync(file, '# comment\nPRD-001/issue-01\n\nissue-11\n');
    const targets = resolveReviewTargets(issues, { file });
    expect(targets.map((item) => item.qualifiedId)).toEqual(['PRD-001/issue-01', 'PRD-002/issue-11']);
  });

  it('throws when the review file does not exist', () => {
    expect(() => resolveReviewTargets(issues, { file: '/nonexistent/targets.txt' })).toThrowError(
      /Review file not found/,
    );
  });
});
