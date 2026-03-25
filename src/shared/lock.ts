/**
 * One mutating loop invocation per repo at a time: runs claim issues by
 * flipping on-disk triage and advance the rolling worktree commit-by-commit —
 * a second concurrent invocation would race both. The lock is advisory (a pid
 * file at `.loop/lock.json`), with liveness-checked takeover so a crashed run
 * never wedges the repo.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loopDir } from './paths.js';

export function lockPath(root: string): string {
  return path.join(loopDir(root), 'lock.json');
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the per-repo invocation lock, returning the release function.
 * Throws when another live loop process holds it; stale locks (dead pid,
 * unparseable file) are taken over silently.
 */
export function acquireInvocationLock(root: string): () => void {
  const filePath = lockPath(root);

  if (existsSync(filePath)) {
    let holder: { pid?: number } = {};
    try {
      holder = JSON.parse(readFileSync(filePath, 'utf8')) as { pid?: number };
    } catch {
      // Corrupt lock file — treat as stale.
    }
    if (typeof holder.pid === 'number' && holder.pid !== process.pid && pidIsAlive(holder.pid)) {
      throw new Error(
        `Another loop invocation (pid ${holder.pid}) is already running in this repo. ` +
          `If that's wrong (e.g. a zombie pid), delete ${filePath} and retry.`,
      );
    }
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return () => rmSync(filePath, { force: true });
}
