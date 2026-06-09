import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupFixtureRepos,
  commitFile,
  createFixtureRepo,
  gitOrThrow,
  trackFixtureDir,
} from '../git/test-helpers.js';
import {
  cleanupIssueWorktree,
  createIssueWorktree,
  flattenQualifiedId,
  listLeftoverIssueWorktrees,
  mergeIssueWorktree,
  resolveIssueBranchName,
  resolveIssueWorktreeDir,
} from './issue-worktree.js';

afterEach(() => {
  cleanupFixtureRepos();
});

function createIssueWorktreeOrThrow(mainRoot: string, qualifiedId: string): { dir: string; branch: string } {
  trackFixtureDir(resolveIssueWorktreeDir(mainRoot, qualifiedId));
  const result = createIssueWorktree(mainRoot, mainRoot, qualifiedId);
  if (!result.ok) throw new Error(result.error);
  return result.worktree;
}

describe('naming', () => {
  it('flattens qualifiedId slashes to dashes for the worktree dir', () => {
    expect(flattenQualifiedId('PRD-006/issue-07')).toBe('PRD-006-issue-07');
  });

  it('names the branch loop/issue/<qualifiedId> (slashes allowed in refs)', () => {
    expect(resolveIssueBranchName('PRD-006/issue-07')).toBe('loop/issue/PRD-006/issue-07');
  });

  it('places the worktree as a sibling of the main repo', () => {
    const dir = resolveIssueWorktreeDir('/repos/polyweave', 'PRD-006/issue-07');
    expect(dir).toBe('/repos/polyweave-loop-PRD-006-issue-07');
  });
});

describe('createIssueWorktree', () => {
  it('creates the worktree and branch cut from the base HEAD', () => {
    const repo = createFixtureRepo();
    const headSha = gitOrThrow(['rev-parse', 'HEAD'], repo);

    const worktree = createIssueWorktreeOrThrow(repo, 'PRD-006/issue-07');

    expect(worktree.branch).toBe('loop/issue/PRD-006/issue-07');
    expect(existsSync(worktree.dir)).toBe(true);
    expect(gitOrThrow(['rev-parse', 'HEAD'], worktree.dir)).toBe(headSha);
    expect(gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], worktree.dir)).toBe('loop/issue/PRD-006/issue-07');
  });

  it('fails without touching anything when the branch already exists (leftover)', () => {
    const repo = createFixtureRepo();
    const first = createIssueWorktreeOrThrow(repo, 'PRD-006/issue-07');
    gitOrThrow(['worktree', 'remove', '--force', first.dir], repo);

    const result = createIssueWorktree(repo, repo, 'PRD-006/issue-07');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('branch already exists');
  });
});

describe('mergeIssueWorktree + cleanupIssueWorktree', () => {
  it('merges a clean issue branch back into the target ref and cleans up', () => {
    const repo = createFixtureRepo();
    const worktree = createIssueWorktreeOrThrow(repo, 'PRD-006/issue-07');
    commitFile(worktree.dir, 'feature.txt', 'feature\n', 'feat: add feature (PRD-006/issue-07)');

    const merge = mergeIssueWorktree(repo, 'main', 'PRD-006/issue-07');
    expect(merge).toEqual({ ok: true });
    expect(readFileSync(path.join(repo, 'feature.txt'), 'utf8')).toBe('feature\n');

    const cleanup = cleanupIssueWorktree(repo, 'PRD-006/issue-07');
    expect(cleanup.ok).toBe(true);
    expect(existsSync(worktree.dir)).toBe(false);
    expect(listLeftoverIssueWorktrees(repo)).toEqual([]);
  });

  it('leaves the worktree and branch intact on a merge conflict', () => {
    const repo = createFixtureRepo();
    commitFile(repo, 'shared.txt', 'base\n', 'chore: add shared');

    const worktree = createIssueWorktreeOrThrow(repo, 'PRD-006/issue-07');
    commitFile(worktree.dir, 'shared.txt', 'issue change\n', 'feat: issue change (PRD-006/issue-07)');
    commitFile(repo, 'shared.txt', 'main change\n', 'chore: main change');

    const merge = mergeIssueWorktree(repo, 'main', 'PRD-006/issue-07');
    expect(merge).toEqual({ ok: false, conflictingFiles: ['shared.txt'] });

    // Worktree, branch, and its unmerged commit all survive for manual resolution.
    expect(existsSync(worktree.dir)).toBe(true);
    expect(readFileSync(path.join(worktree.dir, 'shared.txt'), 'utf8')).toBe('issue change\n');
    expect(gitOrThrow(['rev-parse', '--verify', 'refs/heads/loop/issue/PRD-006/issue-07'], repo)).toBeTruthy();
    expect(gitOrThrow(['status', '--porcelain'], repo)).toBe('');
  });
});

describe('listLeftoverIssueWorktrees', () => {
  it('lists per-issue worktrees and ignores the main checkout and non-issue worktrees', () => {
    const repo = createFixtureRepo();
    createIssueWorktreeOrThrow(repo, 'PRD-006/issue-07');
    createIssueWorktreeOrThrow(repo, 'PRD-004/issue-02');

    // A non-issue worktree (like the rolling worktree) is not reported.
    const otherDir = path.join(path.dirname(repo), `${path.basename(repo)}-other`);
    trackFixtureDir(otherDir);
    gitOrThrow(['worktree', 'add', '-b', 'some/other-branch', otherDir, 'HEAD'], repo);

    const leftovers = listLeftoverIssueWorktrees(repo).sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId));
    expect(leftovers.map((entry) => entry.qualifiedId)).toEqual(['PRD-004/issue-02', 'PRD-006/issue-07']);
    expect(leftovers.map((entry) => entry.branch)).toEqual([
      'loop/issue/PRD-004/issue-02',
      'loop/issue/PRD-006/issue-07',
    ]);
    for (const entry of leftovers) {
      expect(existsSync(entry.dir)).toBe(true);
    }
  });

  it('returns an empty list for a repo with no issue worktrees', () => {
    const repo = createFixtureRepo();
    expect(listLeftoverIssueWorktrees(repo)).toEqual([]);
  });
});