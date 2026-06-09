import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { mergeBranch } from './merge.js';
import { cleanupFixtureRepos, commitFile, createFixtureRepo, gitOrThrow } from './test-helpers.js';

afterEach(() => {
  cleanupFixtureRepos();
});

describe('mergeBranch', () => {
  it('merges a clean branch with --no-ff and stays on the target ref', () => {
    const repo = createFixtureRepo();
    gitOrThrow(['checkout', '-b', 'loop/issue/PRD-001/issue-01'], repo);
    commitFile(repo, 'feature.txt', 'feature\n', 'feat: add feature (PRD-001/issue-01)');
    gitOrThrow(['checkout', 'main'], repo);

    const result = mergeBranch(repo, 'main', 'loop/issue/PRD-001/issue-01');

    expect(result).toEqual({ ok: true });
    expect(gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).toBe('main');
    // --no-ff produces a merge commit even for a fast-forwardable branch.
    expect(gitOrThrow(['rev-list', '--merges', '-1', 'HEAD'], repo)).toBe(gitOrThrow(['rev-parse', 'HEAD'], repo));
    expect(readFileSync(path.join(repo, 'feature.txt'), 'utf8')).toBe('feature\n');
  });

  it('aborts on conflict, reports conflicting files, and leaves both branches intact', () => {
    const repo = createFixtureRepo();
    commitFile(repo, 'shared.txt', 'base\n', 'chore: add shared');

    gitOrThrow(['checkout', '-b', 'loop/issue/PRD-001/issue-02'], repo);
    commitFile(repo, 'shared.txt', 'issue change\n', 'feat: issue change (PRD-001/issue-02)');

    gitOrThrow(['checkout', 'main'], repo);
    commitFile(repo, 'shared.txt', 'main change\n', 'chore: main change');
    const mainShaBefore = gitOrThrow(['rev-parse', 'HEAD'], repo);

    const result = mergeBranch(repo, 'main', 'loop/issue/PRD-001/issue-02');

    expect(result).toEqual({ ok: false, conflictingFiles: ['shared.txt'] });
    // Merge was aborted: no MERGE_HEAD, tree back to the pre-merge state.
    expect(gitOrThrow(['rev-parse', 'HEAD'], repo)).toBe(mainShaBefore);
    expect(gitOrThrow(['status', '--porcelain'], repo)).toBe('');
    expect(readFileSync(path.join(repo, 'shared.txt'), 'utf8')).toBe('main change\n');
    // Source branch still exists for manual resolution.
    expect(gitOrThrow(['rev-parse', '--verify', 'refs/heads/loop/issue/PRD-001/issue-02'], repo)).toBeTruthy();
  });

  it('returns ok:false with no conflicting files when the target ref cannot be checked out', () => {
    const repo = createFixtureRepo();
    const result = mergeBranch(repo, 'no-such-branch', 'also-missing');
    expect(result).toEqual({ ok: false, conflictingFiles: [] });
  });
});
