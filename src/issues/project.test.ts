import { describe, expect, it } from 'vitest';

import { listProjects, resolveProjectFilter } from './project.js';
import { makeIssue } from './test-helpers.js';

const issues = [
  makeIssue({ id: 'issue-01', project: 'PRD-001' }),
  makeIssue({ id: 'issue-02', project: 'PRD-001' }),
  makeIssue({ id: 'issue-01', project: 'PRD-010' }),
  makeIssue({ id: 'issue-01', project: 'add-new-feature' }),
];

describe('listProjects', () => {
  it('returns distinct projects sorted with numeric ordering', () => {
    expect(listProjects(issues)).toEqual(['add-new-feature', 'PRD-001', 'PRD-010']);
  });

  it('returns [] for no issues', () => {
    expect(listProjects([])).toEqual([]);
  });
});

describe('resolveProjectFilter', () => {
  it('matches exactly on issue.project', () => {
    const filter = resolveProjectFilter(issues, 'PRD-001');
    expect(issues.filter(filter).map((issue) => issue.qualifiedId)).toEqual([
      'PRD-001/issue-01',
      'PRD-001/issue-02',
    ]);
  });

  it('matches case-insensitively', () => {
    const filter = resolveProjectFilter(issues, 'prd-010');
    expect(issues.filter(filter).map((issue) => issue.qualifiedId)).toEqual(['PRD-010/issue-01']);
  });

  it('throws listing available projects when nothing matches', () => {
    expect(() => resolveProjectFilter(issues, 'PRD-999')).toThrow(
      /No issues found in project "PRD-999"[\s\S]*add-new-feature, PRD-001, PRD-010/,
    );
  });
});
