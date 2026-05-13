/**
 * Read-only git status helpers. All take an explicit `cwd` (per-worker state
 * threading — loop may operate on the main repo, the rolling worktree, or a
 * per-issue worktree within one process).
 */

import { spawnSync } from 'node:child_process';

export function isGitRepository(cwd: string): boolean {
  const result = spawnSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8' });
  return result.status === 0;
}

export function getHeadSha(cwd: string): string | null {
  if (!isGitRepository(cwd)) return null;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Whether git tracks `relPath` in the repo at `cwd`. Worktrees receive tracked
 * files and nothing else, so this decides whether a path can be handed to a
 * session as repo-relative or has to be made absolute.
 */
export function isTrackedFile(cwd: string, relPath: string): boolean {
  if (!isGitRepository(cwd)) return false;
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', relPath], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return result.status === 0;
}

export function hasUncommittedChanges(cwd: string): boolean {
  if (!isGitRepository(cwd)) return false;
  const result = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().length > 0;
}

/** Repo-relative paths changed, deleted, staged, or untracked in the working tree. */
export function listDirtyPaths(cwd: string): string[] {
  if (!isGitRepository(cwd)) return [];
  // Disable rename collapsing so both the deleted source and added
  // destination are protected when a rename was already staged.
  const tracked = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', 'HEAD'], {
    cwd,
    encoding: 'buffer',
  });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd,
    encoding: 'buffer',
  });
  if (tracked.status !== 0 || untracked.status !== 0) return [];

  return [...new Set(
    Buffer.concat([tracked.stdout, untracked.stdout])
      .toString('utf8')
      .split('\0')
      .filter(Boolean),
  )].sort();
}

export function resolveDefaultBranch(cwd: string): string {
  const originHead = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  if (originHead.status === 0) {
    const match = originHead.stdout.trim().match(/^origin\/(.+)$/);
    if (match?.[1]) return match[1];
  }

  for (const candidate of ['main', 'master']) {
    const result = spawnSync('git', ['rev-parse', '--verify', candidate], { cwd, encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }

  return 'HEAD';
}
