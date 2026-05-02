import { describe, expect, it } from 'vitest';

import { resolveIssueRef } from './resolve-issue-ref.js';
import { makeIssue } from './test-helpers.js';

const issues = [
  makeIssue({ id: 'issue-01', project: 'PRD-A' }),
  makeIssue({ id: 'issue-01', project: 'PRD-B' }),
  makeIssue({ id: 'issue-02', project: 'PRD-B' }),
];

describe('resolveIssueRef', () => {
  it('matches a fully-qualified project/id exactly', () => {
    expect(resolveIssueRef('PRD-B/issue-01', issues).qualifiedId).toBe('PRD-B/issue-01');
  });

  it('accepts a bare local id when it is unambiguous repo-wide', () => {
    expect(resolveIssueRef('issue-02', issues).qualifiedId).toBe('PRD-B/issue-02');
  });

  it('rejects an ambiguous bare local id, listing the candidate projects', () => {
    expect(() => resolveIssueRef('issue-01', issues)).toThrow(
      /ambiguous[\s\S]*PRD-A, PRD-B[\s\S]*PRD-A\/issue-01/,
    );
  });

  it('rejects an unknown reference descriptively', () => {
    expect(() => resolveIssueRef('issue-99', issues)).toThrow(/Unknown issue reference "issue-99"/);
    expect(() => resolveIssueRef('PRD-C/issue-01', issues)).toThrow(/Unknown issue reference/);
  });
});
