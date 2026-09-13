/**
 * Per-issue throwaway worktrees for parallel runs. Each claimed issue gets a
 * sibling worktree `../<repo>-loop-<qualifiedId with / flattened to ->` on a
 * branch `loop/issue/<qualifiedId>` (branch refs allow slashes), cut from
 * the rolling worktree's HEAD. On any terminal outcome the branch merges back
 * into the rolling branch; a conflict leaves the worktree/branch intact for
 * manual resolution.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { mergeBranch, type MergeBranchResult } from '../git/merge.js';

type GitResult = { ok: boolean; stdout: string; stderr: string };

function git(args: string[], cwd: string): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

export const ISSUE_BRANCH_PREFIX = 'loop/issue/';

/** `SPEC-006/issue-07` → `SPEC-006-issue-07` (for filesystem-safe dir names). */
export function flattenQualifiedId(qualifiedId: string): string {
  return qualifiedId.replace(/\//g, '-');
}

export function resolveIssueBranchName(qualifiedId: string): string {
  return `${ISSUE_BRANCH_PREFIX}${qualifiedId}`;
}

/** Sibling dir next to the main repo, e.g. `../polyweave-loop-SPEC-006-issue-07`. */
export function resolveIssueWorktreeDir(mainRoot: string, qualifiedId: string): string {
  return path.resolve(mainRoot, '..', `${path.basename(mainRoot)}-loop-${flattenQualifiedId(qualifiedId)}`);
}

export type IssueWorktree = {
  dir: string;
  branch: string;
  qualifiedId: string;
};

export type CreateIssueWorktreeResult =
  | { ok: true; worktree: IssueWorktree }
  | { ok: false; error: string };

/**
 * Create the issue's worktree/branch, cut from `baseRoot`'s current HEAD
 * (the rolling worktree — or the main repo when worktrees are disabled).
 * Fails without touching anything when the dir or branch already exists
 * (a leftover from a previous run — see listLeftoverIssueWorktrees).
 */
export function createIssueWorktree(
  mainRoot: string,
  baseRoot: string,
  qualifiedId: string,
): CreateIssueWorktreeResult {
  const branch = resolveIssueBranchName(qualifiedId);
  const dir = resolveIssueWorktreeDir(mainRoot, qualifiedId);

  if (existsSync(dir)) {
    return { ok: false, error: `worktree dir already exists: ${dir}` };
  }
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], baseRoot).ok) {
    return { ok: false, error: `branch already exists: ${branch}` };
  }

  const added = git(['worktree', 'add', '-b', branch, dir, 'HEAD'], baseRoot);
  if (!added.ok) {
    return { ok: false, error: added.stderr || 'git worktree add failed' };
  }

  return { ok: true, worktree: { dir, branch, qualifiedId } };
}

/**
 * Merge the issue's branch back into `targetRef`, checked out in
 * `targetRoot` (the rolling worktree). A conflict aborts and reports the
 * conflicting files; the issue worktree/branch stay intact either way —
 * call cleanupIssueWorktree separately after a clean merge.
 */
export function mergeIssueWorktree(
  targetRoot: string,
  targetRef: string,
  qualifiedId: string,
): MergeBranchResult {
  return mergeBranch(targetRoot, targetRef, resolveIssueBranchName(qualifiedId));
}

export type CleanupIssueWorktreeResult = { ok: boolean; messages: string[] };

/** Remove the issue's worktree and delete its branch (after a clean merge). */
export function cleanupIssueWorktree(mainRoot: string, qualifiedId: string): CleanupIssueWorktreeResult {
  const branch = resolveIssueBranchName(qualifiedId);
  const dir = resolveIssueWorktreeDir(mainRoot, qualifiedId);
  const messages: string[] = [];
  let ok = true;

  const removed = git(['worktree', 'remove', '--force', dir], mainRoot);
  if (!removed.ok) {
    ok = false;
    messages.push(`[loop] failed to remove issue worktree ${dir}: ${removed.stderr || 'unknown error'}`);
  }

  const deleted = git(['branch', '-D', branch], mainRoot);
  if (!deleted.ok) {
    ok = false;
    messages.push(`[loop] failed to delete issue branch ${branch}: ${deleted.stderr || 'unknown error'}`);
  }

  return { ok, messages };
}

/**
 * Per-issue worktrees left over from a previous crashed/force-killed run
 * (registered worktrees on a `loop/issue/...` branch). Detected and listed
 * at startup — never auto-resumed or deleted.
 */
export function listLeftoverIssueWorktrees(mainRoot: string): IssueWorktree[] {
  const result = git(['worktree', 'list', '--porcelain'], mainRoot);
  if (!result.ok) return [];

  const leftovers: IssueWorktree[] = [];
  let currentDir: string | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentDir = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch refs/heads/') && currentDir) {
      const branch = line.slice('branch refs/heads/'.length).trim();
      if (branch.startsWith(ISSUE_BRANCH_PREFIX)) {
        leftovers.push({
          dir: currentDir,
          branch,
          qualifiedId: branch.slice(ISSUE_BRANCH_PREFIX.length),
        });
      }
    }
  }
  return leftovers;
}
