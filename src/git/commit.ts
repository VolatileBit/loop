/**
 * Loop's per-stage commits. Staging is config-driven: stage everything,
 * minus the repo's `commitExcludePaths` pathspecs (replacing the old
 * hardcoded allowlist). Commit messages reference issues by `qualifiedId`
 * (e.g. `feat: implement (SPEC-006/issue-07)`).
 */

import { spawnSync } from 'node:child_process';

import { getHeadSha, hasUncommittedChanges, isGitRepository } from './status.js';

/** Conventional-commit-style type prefixes loop uses/suggests for its commits. */
export const LOOP_COMMIT_TYPES = ['feat', 'fix', 'doc', 'chore', 'review'] as const;
export type LoopCommitType = (typeof LOOP_COMMIT_TYPES)[number];

export function isLoopCommitType(value: string): value is LoopCommitType {
  return (LOOP_COMMIT_TYPES as readonly string[]).includes(value);
}

export type CommitSuggestion = { type: LoopCommitType; summary: string };

/** Default type for loop's own fallback commits when the agent didn't suggest one. */
export function defaultCommitTypeForLabel(label: string): LoopCommitType {
  if (label.startsWith('review-fix') || label.startsWith('verify-fix')) return 'fix';
  if (label === 'implement') return 'feat';
  if (label === 'escalate' || label.startsWith('review')) return 'review';
  return 'chore';
}

function humanizeLabel(label: string): string {
  return label.replace(/-/g, ' ');
}

/**
 * Builds `<type>: <summary> (<qualifiedId>)`, e.g.
 * `feat: add per-task-type timeouts (SPEC-006/issue-07)`. Uses the agent's
 * suggested type/summary when available, otherwise falls back to a type
 * inferred from the loop-internal stage label.
 */
export function buildLoopCommitMessage(
  qualifiedId: string,
  label: string,
  suggestion?: CommitSuggestion | null,
): string {
  const type = suggestion?.type ?? defaultCommitTypeForLabel(label);
  const summary = suggestion?.summary?.trim() || humanizeLabel(label);
  return `${type}: ${summary} (${qualifiedId})`;
}

export function resolveImplementCommitLabel(options: {
  commitLabel?: string | undefined;
  verifyFeedback?: { round: number } | undefined;
  reviewFeedback?: { round: number } | undefined;
}): string {
  if (options.commitLabel) return options.commitLabel;
  if (options.verifyFeedback) return `verify-fix-${options.verifyFeedback.round}`;
  if (options.reviewFeedback) return `review-fix-${options.reviewFeedback.round}`;
  return 'implement';
}

export const LOOP_COMMIT_HEADING = '## Loop commit';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extracts the markdown body under `heading` up to the next `## ` heading or end of text. */
function extractSectionBody(text: string, heading: string): string | null {
  const match = text.match(new RegExp(`${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?:\\n## |$)`, 'i'));
  return match ? (match[1] ?? '').trim() : null;
}

/** Agent-suggested commit type/summary from the optional `## Loop commit` block. */
export function parseCommitSuggestion(text: string): CommitSuggestion | null {
  const block = extractSectionBody(text.trim(), LOOP_COMMIT_HEADING);
  if (!block) return null;
  const typeRaw = block.match(/^type:\s*(\S+)\s*$/im)?.[1]?.toLowerCase();
  const summary = block.match(/^summary:\s*(.+)\s*$/im)?.[1]?.trim();
  if (!typeRaw || !summary || !isLoopCommitType(typeRaw)) return null;
  return { type: typeRaw, summary };
}

/**
 * Stage everything, then unstage the configured exclude paths. Add-then-reset
 * rather than `:!` pathspec excludes: with an explicit pathspec, `git add`
 * exits 1 whenever a gitignored directory (like a properly ignored `.loop/`)
 * falls under it — even though staging succeeded. `.loop/` is always excluded:
 * it's runtime state that should be gitignored, but when a repo forgets the
 * ignore, staging it would put run artifacts in the diff — and a later review
 * fix session "cleaning up" those files deletes the live run dir mid-run.
 */
export function stageLoopChanges(cwd: string, excludePaths: string[] = []): { ok: boolean; output: string } {
  const add = spawnSync('git', ['add', '-A'], { cwd, encoding: 'utf8' });
  const addOutput = `${add.stdout ?? ''}${add.stderr ?? ''}`;
  if (add.status !== 0) return { ok: false, output: addOutput };

  const excludes = ['.loop', ...excludePaths];
  const reset = spawnSync('git', ['reset', '-q', '--', ...excludes], { cwd, encoding: 'utf8' });
  const output = `${addOutput}${reset.stdout ?? ''}${reset.stderr ?? ''}`;
  return { ok: reset.status === 0, output };
}

export function commitStagedChanges(message: string, cwd: string): { ok: boolean; sha: string | null; output: string } {
  const commit = spawnSync('git', ['commit', '-m', message], { cwd, encoding: 'utf8' });
  const output = `${commit.stdout ?? ''}${commit.stderr ?? ''}`;
  if (commit.status !== 0) {
    if (!hasUncommittedChanges(cwd)) {
      return { ok: true, sha: getHeadSha(cwd), output };
    }
    return { ok: false, sha: null, output };
  }
  return { ok: true, sha: getHeadSha(cwd), output };
}

function hasStagedChanges(cwd: string): boolean {
  const result = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd });
  return result.status === 1;
}

function captureStagedPatch(cwd: string, paths: string[]): { ok: boolean; patch: Buffer; output: string } {
  if (paths.length === 0) return { ok: true, patch: Buffer.alloc(0), output: '' };
  const result = spawnSync(
    'git',
    ['diff', '--cached', '--binary', '--full-index', '--', ...paths],
    { cwd, encoding: 'buffer' },
  );
  return {
    ok: result.status === 0,
    patch: result.stdout ?? Buffer.alloc(0),
    output: result.stderr?.toString('utf8') ?? '',
  };
}

function restoreStagedPatch(cwd: string, patch: Buffer): { ok: boolean; output: string } {
  if (patch.length === 0) return { ok: true, output: '' };
  const result = spawnSync(
    'git',
    ['apply', '--cached', '--whitespace=nowarn', '-'],
    { cwd, input: patch, encoding: 'buffer' },
  );
  return {
    ok: result.status === 0,
    output: `${result.stdout?.toString('utf8') ?? ''}${result.stderr?.toString('utf8') ?? ''}`,
  };
}

export type LoopCommitResult = {
  committed: boolean;
  sha: string | null;
  message: string;
  output: string;
  warning?: string;
};

export type EnsureLoopCommitOptions = {
  /** Where the commit happens: main repo, rolling worktree, or per-issue worktree. */
  cwd: string;
  /** Config-driven `commitExcludePaths`. Empty/omitted = stage everything. */
  excludePaths?: string[] | undefined;
  /** Paths already dirty before this stage/run; never absorb them into a fallback commit. */
  preservePaths?: string[] | undefined;
  /** Agent-suggested type/summary (parsed from the `## Loop commit` block), if any. */
  suggestion?: CommitSuggestion | null | undefined;
};

/** Commit dirty changes (minus excludes) with a standard message, or no-op when clean. */
export function ensureLoopCommit(
  qualifiedId: string,
  label: string,
  options: EnsureLoopCommitOptions,
): LoopCommitResult {
  const { cwd } = options;
  const message = buildLoopCommitMessage(qualifiedId, label, options.suggestion);

  if (!isGitRepository(cwd)) {
    return { committed: false, sha: null, message, output: 'not a git repository' };
  }

  if (!hasUncommittedChanges(cwd)) {
    return { committed: false, sha: getHeadSha(cwd), message, output: 'working tree clean' };
  }

  const preservePaths = [...new Set(options.preservePaths ?? [])];
  const stagedSnapshot = captureStagedPatch(cwd, preservePaths);
  if (!stagedSnapshot.ok) {
    return {
      committed: false,
      sha: getHeadSha(cwd),
      message,
      output: `could not snapshot pre-existing staged changes: ${stagedSnapshot.output}`,
    };
  }

  const staged = stageLoopChanges(cwd, [...(options.excludePaths ?? []), ...preservePaths]);
  if (!staged.ok) {
    return { committed: false, sha: getHeadSha(cwd), message, output: staged.output };
  }

  if (!hasStagedChanges(cwd)) {
    const restored = restoreStagedPatch(cwd, stagedSnapshot.patch);
    return {
      committed: false,
      sha: getHeadSha(cwd),
      message,
      output: restored.ok ? 'no loop changes to commit' : `could not restore pre-existing staged changes: ${restored.output}`,
    };
  }

  const result = commitStagedChanges(message, cwd);
  const restored = restoreStagedPatch(cwd, stagedSnapshot.patch);
  return {
    committed: result.ok,
    sha: result.sha,
    message,
    output: `${staged.output}${result.output}${restored.output}`,
    ...(restored.ok ? {} : { warning: `could not restore pre-existing staged changes: ${restored.output}` }),
  };
}
