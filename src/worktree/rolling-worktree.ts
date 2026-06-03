/**
 * Rolling loop worktree: all loop work happens on a dedicated git worktree
 * based on the current branch, so the main checkout is never touched
 * mid-run.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

type GitResult = { ok: boolean; stdout: string; stderr: string };

function git(args: string[], cwd: string): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

export function resolveWorktreeDir(mainRoot: string): string {
  return path.resolve(mainRoot, '..', `${path.basename(mainRoot)}-loop`);
}

export function resolveRollingBranchName(currentBranch: string): string {
  return `loop/rolling/${currentBranch}`;
}

export function getCurrentBranchName(cwd: string): string | null {
  const result = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!result.ok) return null;
  if (!result.stdout || result.stdout === 'HEAD') return null; // detached HEAD
  return result.stdout;
}

function branchExists(cwd: string, branch: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd).ok;
}
