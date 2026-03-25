/**
 * One mutating loop invocation per repo at a time: runs claim issues by
 * flipping on-disk triage and advance the rolling worktree commit-by-commit —
 * a second concurrent invocation would race both. The lock is advisory (a
 * marker file at `.loop/lock.json`) and has to be cleared by hand if a run
 * dies holding it.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loopDir } from './paths.js';

export function lockPath(root: string): string {
  return path.join(loopDir(root), 'lock.json');
}

/**
 * Acquire the per-repo invocation lock, returning the release function.
 * Throws when the lock file already exists.
 */
export function acquireInvocationLock(root: string): () => void {
  const filePath = lockPath(root);

  if (existsSync(filePath)) {
    throw new Error(
      `Another loop invocation is already running in this repo. ` +
        `If that's wrong, delete ${filePath} and retry.`,
    );
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return () => rmSync(filePath, { force: true });
}
