/**
 * Rolling loop worktree: all loop work happens on a dedicated git worktree
 * based on the current branch, so the main checkout is never touched mid-run.
 * Merging back is a manual human sign-off (`git merge` from the current branch).
 *
 * Lifecycle (run once per loop invocation, before the issue loop):
 * - First run: create a sibling worktree (`../<repo>-loop`) on a new branch
 *   `loop/rolling/<currentBranch>`, based on the current branch's tip.
 * - Later runs: if the rolling branch has already been fully merged into the
 *   current branch (fast-forwardable, and the worktree has no uncommitted
 *   changes), fast-forward the worktree to the current branch's tip so loop
 *   keeps building on fresh code.
 * - If the worktree has unmerged commits or uncommitted changes ("dirty"),
 *   leave it alone — syncing would discard or conflict with work that hasn't
 *   been signed off yet.
 *
 * Dependency auto-install is config-driven: when `installCmd` is set and any
 * of `dependencyFiles` changed in the synced commits, the command runs in the
 * worktree. No `installCmd` = auto-install disabled.
 *
 * `.loop/` bookkeeping (run logs, state.json) always stays in the main repo,
 * never in the worktree, so run history survives worktree resets/re-syncs.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../config/load-config.js';
import { getHeadSha, hasUncommittedChanges, isGitRepository } from '../git/status.js';
import { shell } from '../shared/shell.js';

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

/** Path of the registered worktree checked out on `branch`, if any (via `git worktree list`). */
function findRegisteredWorktreePath(cwd: string, branch: string): string | null {
  const result = git(['worktree', 'list', '--porcelain'], cwd);
  if (!result.ok) return null;

  let currentPath: string | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length).trim();
    else if (line === `branch refs/heads/${branch}` && currentPath) return currentPath;
  }
  return null;
}

/** True when `ancestorRef` is fully reachable from `descendantRef` (fast-forwardable / merged). */
function isAncestor(cwd: string, ancestorRef: string, descendantRef: string): boolean {
  return git(['merge-base', '--is-ancestor', ancestorRef, descendantRef], cwd).ok;
}

function dependencyFilesChanged(
  cwd: string,
  fromSha: string,
  toSha: string,
  dependencyFiles: string[],
): boolean {
  if (fromSha === toSha || dependencyFiles.length === 0) return false;
  const result = git(['diff', '--name-only', fromSha, toSha], cwd);
  if (!result.ok) return false;
  const names = new Set(dependencyFiles);
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .some((entry) => names.has(entry) || names.has(path.basename(entry)));
}

export type RollingWorktreeResult = {
  usingWorktree: boolean;
  workRoot: string;
  currentBranch: string | null;
  rollingBranch: string | null;
  synced: boolean;
  skippedSyncReason: 'uncommitted-changes' | 'unmerged-commits' | 'uncommitted-and-unmerged' | null;
  ranInstall: boolean;
  messages: string[];
};

export type EnsureRollingWorktreeOptions = {
  disabled?: boolean;
  /** Dependency install command (config `installCmd`). Unset/null = auto-install disabled. */
  installCmd?: string | null;
  /** Files whose changes in synced commits trigger `installCmd` (config `dependencyFiles`). */
  dependencyFiles?: string[];
};

function fallback(mainRoot: string, messages: string[]): RollingWorktreeResult {
  return {
    usingWorktree: false,
    workRoot: mainRoot,
    currentBranch: null,
    rollingBranch: null,
    synced: false,
    skippedSyncReason: null,
    ranInstall: false,
    messages,
  };
}

export function ensureRollingWorktree(
  mainRoot: string,
  options: EnsureRollingWorktreeOptions = {},
): RollingWorktreeResult {
  const installCmd = options.installCmd ?? null;
  const dependencyFiles = options.dependencyFiles ?? DEFAULT_CONFIG.dependencyFiles;

  if (options.disabled) {
    return fallback(mainRoot, ['[loop] worktree disabled (--no-worktree) — operating directly in the repo.']);
  }

  if (!isGitRepository(mainRoot)) {
    return fallback(mainRoot, ['[loop] not a git repository — worktree feature unavailable, operating directly in the repo.']);
  }

  const currentBranch = getCurrentBranchName(mainRoot);
  if (!currentBranch) {
    return fallback(mainRoot, ['[loop] HEAD is detached — worktree feature unavailable, operating directly in the repo.']);
  }

  const rollingBranch = resolveRollingBranchName(currentBranch);
  const worktreeDir = resolveWorktreeDir(mainRoot);
  const registeredPath = findRegisteredWorktreePath(mainRoot, rollingBranch);
  const messages: string[] = [];

  if (!registeredPath) {
    if (existsSync(worktreeDir)) {
      return fallback(mainRoot, [
        `[loop] ${worktreeDir} exists but is not a registered worktree for ${rollingBranch} — refusing to touch it. Operating directly in the repo. Remove or rename it, or delete .git worktree state, to re-enable.`,
      ]);
    }

    const addArgs = branchExists(mainRoot, rollingBranch)
      ? ['worktree', 'add', worktreeDir, rollingBranch]
      : ['worktree', 'add', '-b', rollingBranch, worktreeDir, currentBranch];
    const added = git(addArgs, mainRoot);
    if (!added.ok) {
      return fallback(mainRoot, [
        `[loop] failed to create rolling worktree (${added.stderr || 'unknown error'}) — operating directly in the repo.`,
      ]);
    }

    messages.push(`[loop] created rolling worktree at ${worktreeDir} on branch ${rollingBranch} (base: ${currentBranch}).`);
    return {
      usingWorktree: true,
      workRoot: worktreeDir,
      currentBranch,
      rollingBranch,
      synced: true,
      skippedSyncReason: null,
      ranInstall: false,
      messages,
    };
  }

  const worktreeDirResolved = registeredPath;
  const uncommitted = hasUncommittedChanges(worktreeDirResolved);
  const merged = isAncestor(mainRoot, rollingBranch, currentBranch);
  const alreadyUpToDate = getHeadSha(worktreeDirResolved) === getHeadSha(mainRoot) && merged;

  if (uncommitted || !merged) {
    const reason: RollingWorktreeResult['skippedSyncReason'] =
      uncommitted && !merged ? 'uncommitted-and-unmerged' : uncommitted ? 'uncommitted-changes' : 'unmerged-commits';
    messages.push(
      `[loop] rolling worktree at ${worktreeDirResolved} is dirty (${reason}) — skipping sync. Merge it into ${currentBranch} manually when ready.`,
    );
    return {
      usingWorktree: true,
      workRoot: worktreeDirResolved,
      currentBranch,
      rollingBranch,
      synced: false,
      skippedSyncReason: reason,
      ranInstall: false,
      messages,
    };
  }

  if (alreadyUpToDate) {
    messages.push(`[loop] rolling worktree at ${worktreeDirResolved} is already up to date with ${currentBranch}.`);
    return {
      usingWorktree: true,
      workRoot: worktreeDirResolved,
      currentBranch,
      rollingBranch,
      synced: true,
      skippedSyncReason: null,
      ranInstall: false,
      messages,
    };
  }

  const preSyncSha = getHeadSha(worktreeDirResolved) ?? '';
  const ff = git(['merge', '--ff-only', currentBranch], worktreeDirResolved);
  if (!ff.ok) {
    messages.push(
      `[loop] rolling worktree fast-forward failed (${ff.stderr || 'unknown error'}) — leaving worktree as-is.`,
    );
    return {
      usingWorktree: true,
      workRoot: worktreeDirResolved,
      currentBranch,
      rollingBranch,
      synced: false,
      skippedSyncReason: null,
      ranInstall: false,
      messages,
    };
  }

  const postSyncSha = getHeadSha(worktreeDirResolved) ?? '';
  messages.push(`[loop] synced rolling worktree at ${worktreeDirResolved} to ${currentBranch} tip (${postSyncSha.slice(0, 7)}).`);

  let ranInstall = false;
  if (dependencyFilesChanged(worktreeDirResolved, preSyncSha, postSyncSha, dependencyFiles)) {
    if (installCmd) {
      messages.push(`[loop] dependency files changed in synced commits — running \`${installCmd}\` in worktree…`);
      const installResult = shell(installCmd, worktreeDirResolved);
      ranInstall = installResult.ok;
      if (!installResult.ok) {
        messages.push(`[loop] \`${installCmd}\` failed in worktree: ${installResult.output.trim() || 'unknown error'}`);
      }
    } else {
      messages.push('[loop] dependency files changed in synced commits, but no installCmd is configured — skipping auto-install.');
    }
  }

  return {
    usingWorktree: true,
    workRoot: worktreeDirResolved,
    currentBranch,
    rollingBranch,
    synced: true,
    skippedSyncReason: null,
    ranInstall,
    messages,
  };
}
