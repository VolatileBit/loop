/**
 * Review fixed point: the baseline commit a review session diffs against —
 * the explicit run start SHA when known, else the parent of the first loop
 * commit for the issue found in history, else the default branch.
 *
 * The commit-message grep matches both the current qualified-id suffix form
 * (`(PRD-006/issue-07)`) and the legacy pre-project form (`(PRD-006-07)`) —
 * commits made under the old globally-unique id scheme remain in history.
 */

import { spawnSync } from 'node:child_process';

import { isGitRepository, resolveDefaultBranch } from './status.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Commit-message id strings that may reference this issue in history: the
 * qualifiedId itself, plus the legacy `<project>-<NN>` form derived from a
 * local id with a trailing number (e.g. `PRD-006/issue-07` → `PRD-006-07`).
 */
function issueIdCandidates(qualifiedId: string): string[] {
  const candidates = [qualifiedId];
  const slash = qualifiedId.indexOf('/');
  if (slash !== -1) {
    const project = qualifiedId.slice(0, slash);
    const localId = qualifiedId.slice(slash + 1);
    const digits = localId.match(/(\d+)$/)?.[1];
    if (digits) candidates.push(`${project}-${digits}`);
  }
  return candidates;
}

/** Extended-regexp for `git log --grep` matching any known form of loop commit for the issue. */
export function buildFixedPointGrep(qualifiedId: string): string {
  return issueIdCandidates(qualifiedId)
    .map(escapeRegExp)
    .flatMap((escaped) => [`loop\\(${escaped}\\):`, `\\(${escaped}\\)$`])
    .join('|');
}

/**
 * Fixed point for review: explicit run start SHA, parent of the first loop
 * commit for the issue, or the default branch.
 */
export function resolveIssueReviewFixedPoint(
  qualifiedId: string,
  issueStartSha: string | null | undefined,
  cwd: string,
): string {
  if (issueStartSha?.trim()) return issueStartSha.trim();

  if (!isGitRepository(cwd)) {
    return resolveDefaultBranch(cwd);
  }

  const grep = buildFixedPointGrep(qualifiedId);
  // No `-1` here: git applies commit limiting *before* `--reverse`, so
  // `--reverse -1` would return the newest match instead of the oldest.
  const first = spawnSync(
    'git',
    ['log', '--extended-regexp', '--grep', grep, '--reverse', '--format=%H'],
    { cwd, encoding: 'utf8' },
  );
  const firstSha = first.stdout.trim().split('\n')[0]?.trim() ?? '';
  if (first.status === 0 && firstSha) {
    const parent = spawnSync('git', ['rev-parse', `${firstSha}^`], { cwd, encoding: 'utf8' });
    if (parent.status === 0 && parent.stdout.trim()) {
      return parent.stdout.trim();
    }
  }

  return resolveDefaultBranch(cwd);
}

export function formatReviewFixedPoint(fixedPoint: string, qualifiedId: string): string {
  if (/^[0-9a-f]{7,40}$/i.test(fixedPoint)) {
    return [
      `commit \`${fixedPoint}\` (baseline before this issue's loop work)`,
      `- Diff: \`git diff ${fixedPoint}...HEAD\``,
      `- Commits: \`git log ${fixedPoint}..HEAD --oneline\` (messages end with \`(${qualifiedId})\` when the agent changed files)`,
      `- If the diff is **empty**, the work may already exist — review the **current codebase** against the issue spec; do not require new commits.`,
    ].join('\n');
  }
  return fixedPoint;
}
