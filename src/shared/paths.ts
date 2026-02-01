/**
 * Repo-root resolution and `.loop/` runtime paths.
 *
 * Loop is repo-agnostic: the target repo is always the current working
 * directory (like git/eslint), never a path derived from loop's own file
 * location. All `.loop/` bookkeeping (runs, handoffs, state) lives in the
 * main repo root — never inside a worktree — so history survives worktree
 * resets. Run dirs and handoff files nest by issue project, mirroring the
 * `issues/` tree (e.g. `.loop/handoffs/<project>/<id>.md`).
 */

import path from 'node:path';

export const LOOP_DIR_NAME = '.loop';

/** The target repo root: always the process's current working directory. */
export function resolveRoot(): string {
  return process.cwd();
}

/** `.loop/` runtime directory (gitignored, distinct from tracked loop.config.json). */
export function loopDir(root: string): string {
  return path.join(root, LOOP_DIR_NAME);
}

/** Per-run artifact directories live under here, nested by project. */
export function runsDir(root: string): string {
  return path.join(loopDir(root), 'runs');
}

/** Handoff notes live at `.loop/handoffs/<project>/<id>.md`. */
export function handoffsDir(root: string): string {
  return path.join(loopDir(root), 'handoffs');
}

export function runsIndexPath(root: string): string {
  return path.join(loopDir(root), 'runs.jsonl');
}

export function reviewsIndexPath(root: string): string {
  return path.join(loopDir(root), 'reviews.jsonl');
}

export function statePath(root: string): string {
  return path.join(loopDir(root), 'state.json');
}

export function nitsPath(root: string): string {
  return path.join(loopDir(root), 'nits.md');
}
