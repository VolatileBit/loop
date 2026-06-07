import { afterEach, describe, expect, it } from 'vitest';

import {
  buildFixedPointGrep,
  formatReviewFixedPoint,
  resolveIssueReviewFixedPoint,
} from './fixed-point.js';
import { cleanupFixtureRepos, commitFile, createFixtureRepo, gitOrThrow } from './test-helpers.js';

afterEach(() => {
  cleanupFixtureRepos();
});

describe('buildFixedPointGrep', () => {
  it('matches the current qualified suffix and legacy prefix forms', () => {
    const grep = buildFixedPointGrep('PRD-006/issue-07');
    expect(grep).toContain('\\(PRD-006/issue-07\\)$');
    expect(grep).toContain('loop\\(PRD-006/issue-07\\):');
    // Legacy pre-project form derived from the trailing number of the local id.
    expect(grep).toContain('\\(PRD-006-07\\)$');
  });

  it('adds no legacy form when the local id has no trailing number', () => {
    const grep = buildFixedPointGrep('backlog/fix-login');
    expect(grep.split('|')).toHaveLength(2);
  });
});

describe('formatReviewFixedPoint', () => {
  it('expands commit SHAs into diff instructions', () => {
    const formatted = formatReviewFixedPoint('abc1234', 'PRD-001/issue-01');
    expect(formatted).toContain('abc1234');
    expect(formatted).toContain('git diff abc1234...HEAD');
    expect(formatted).toContain('(PRD-001/issue-01)');
    expect(formatted).toContain('diff is **empty**');
  });

  it('passes through branch names unchanged', () => {
    expect(formatReviewFixedPoint('main', 'PRD-001/issue-01')).toBe('main');
  });
});

describe('resolveIssueReviewFixedPoint', () => {
  it('prefers an explicit issue start SHA', () => {
    expect(resolveIssueReviewFixedPoint('PRD-001/issue-01', 'deadbeef', process.cwd())).toBe('deadbeef');
  });

  it('resolves the parent of the first loop commit using the new qualified suffix', () => {
    const repo = createFixtureRepo();
    const baseSha = gitOrThrow(['rev-parse', 'HEAD'], repo);
    commitFile(repo, 'a.txt', 'a\n', 'feat: implement (PRD-006/issue-07)');
    commitFile(repo, 'b.txt', 'b\n', 'fix: verify fix 1 (PRD-006/issue-07)');

    expect(resolveIssueReviewFixedPoint('PRD-006/issue-07', null, repo)).toBe(baseSha);
  });

  it('resolves commits made under the legacy pre-project id form', () => {
    const repo = createFixtureRepo();
    const baseSha = gitOrThrow(['rev-parse', 'HEAD'], repo);
    commitFile(repo, 'a.txt', 'a\n', 'feat: implement (PRD-006-07)');
    commitFile(repo, 'b.txt', 'b\n', 'chore: unrelated');

    expect(resolveIssueReviewFixedPoint('PRD-006/issue-07', null, repo)).toBe(baseSha);
  });

  it('takes the oldest matching commit when legacy and new forms both exist', () => {
    const repo = createFixtureRepo();
    const baseSha = gitOrThrow(['rev-parse', 'HEAD'], repo);
    commitFile(repo, 'a.txt', 'a\n', 'feat: implement (PRD-006-07)');
    commitFile(repo, 'b.txt', 'b\n', 'fix: follow-up (PRD-006/issue-07)');

    expect(resolveIssueReviewFixedPoint('PRD-006/issue-07', null, repo)).toBe(baseSha);
  });

  it('falls back to the default branch when no loop commit matches', () => {
    const repo = createFixtureRepo();
    expect(resolveIssueReviewFixedPoint('PRD-006/issue-07', null, repo)).toBe('main');
  });
});
