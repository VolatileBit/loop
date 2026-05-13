/**
 * Per-run bookkeeping context — an explicit per-worker value threaded through
 * the pipeline (never a module-level singleton; parallel workers each carry
 * their own). Run artifact dirs nest by issue project, mirroring the issues/
 * tree: `.loop/runs/<project>/<timestamp>-<id>/`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getHeadSha } from '../git/status.js';
import type { IssueRecord } from '../issues/types.js';
import { runsDir } from '../shared/paths.js';
import type { StageUsage } from '../usage/tokens.js';

/** One loop commit made during a run (see git/log-commit.ts). */
export type LoopCommitRecord = {
  label: string;
  message: string;
  sha: string | null;
  committed: boolean;
  at: string;
};

export type RunContext = {
  runId: string;
  runDir: string;
  startedAt: string;
  issue: IssueRecord;
  iteration: number;
  /** Where agent work happens for this run (rolling or per-issue worktree). */
  workRoot: string;
  issueStartSha: string | null;
  /** Paths dirty before Loop claimed this issue; fallback commits must preserve them. */
  preExistingDirtyPaths: string[];
  commits: LoopCommitRecord[];
  usageEntries: StageUsage[];
  promptPath: string;
  agentLogPath: string;
  verifyLogPath: string;
  summaryPath: string;
};

export function formatRunTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '');
}

/**
 * Create the run directory (`.loop/runs/<project>/<timestamp>-<id>/` under
 * `root`, the main repo — never a worktree) and seed it with the prompt and
 * git context. `workRoot` is where the issue's git work happens; it defaults
 * to `root` when no worktree is in play.
 */
export function createRunContext(
  issue: IssueRecord,
  iteration: number,
  prompt: string,
  root: string,
  workRoot: string = root,
  preExistingDirtyPaths: string[] = [],
): RunContext {
  const startedAt = new Date();
  const runId = `${formatRunTimestamp(startedAt)}-${issue.id}`;
  const runDir = path.join(runsDir(root), issue.project, runId);
  mkdirSync(runDir, { recursive: true });

  const ctx: RunContext = {
    runId,
    runDir,
    startedAt: startedAt.toISOString(),
    issue,
    iteration,
    workRoot,
    issueStartSha: getHeadSha(workRoot),
    preExistingDirtyPaths,
    commits: [],
    usageEntries: [],
    promptPath: path.join(runDir, 'prompt.md'),
    agentLogPath: path.join(runDir, 'agent.stream.log'),
    verifyLogPath: path.join(runDir, 'verify.log'),
    summaryPath: path.join(runDir, 'summary.json'),
  };

  writeFileSync(ctx.promptPath, `${prompt}\n`);
  writeFileSync(
    path.join(runDir, 'git-context.json'),
    `${JSON.stringify({ issueId: issue.qualifiedId, issueStartSha: ctx.issueStartSha }, null, 2)}\n`,
  );
  return ctx;
}
