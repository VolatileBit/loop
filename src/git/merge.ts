/**
 * Merge a per-issue branch back into a target ref (the rolling worktree's
 * branch) with `git merge --no-ff`. A conflict aborts the merge and reports
 * the conflicting files, leaving the source branch/worktree intact for
 * manual resolution.
 */

import { spawnSync } from 'node:child_process';

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

export type MergeBranchResult = { ok: true } | { ok: false; conflictingFiles: string[] };

/**
 * Checks out `targetRef` in `repoDir` and merges `sourceBranch` into it with
 * `--no-ff`. On conflict the merge is aborted and the conflicting file paths
 * (repo-relative) are returned; a non-conflict failure (e.g. unknown ref)
 * returns `ok: false` with an empty file list.
 */
export function mergeBranch(repoDir: string, targetRef: string, sourceBranch: string): MergeBranchResult {
  const checkout = git(['checkout', targetRef], repoDir);
  if (!checkout.ok) return { ok: false, conflictingFiles: [] };

  const merge = git(['merge', '--no-ff', '--no-edit', sourceBranch], repoDir);
  if (merge.ok) return { ok: true };

  const conflicts = git(['diff', '--name-only', '--diff-filter=U'], repoDir);
  const conflictingFiles = conflicts.ok
    ? conflicts.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];

  git(['merge', '--abort'], repoDir);
  return { ok: false, conflictingFiles };
}
