/**
 * Durable per-run records: a `summary.json` in the run dir plus an append-only
 * `.loop/runs.jsonl` index in the main repo root.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { TriageLabels } from '../config/triage-labels.js';
import { getHeadSha } from '../git/status.js';
import { setIssueTriage } from '../issues/lifecycle.js';
import { loopDir, runsIndexPath } from '../shared/paths.js';
import { formatUsageTable, type StageUsage } from '../usage/tokens.js';
import type { LoopCommitRecord, RunContext } from './run-context.js';

export type RunRecord = {
  runId: string;
  startedAt: string;
  endedAt: string;
  /** The issue's qualifiedId (`project/id`) — the global identity string. */
  issueId: string;
  issueFile: string;
  issueTitle: string;
  iteration: number;
  model: string;
  outcome: string;
  agentOk: boolean;
  verifyOk: boolean | null;
  issueDone: boolean;
  usageLimited: boolean;
  stuckReason: string | null;
  /** Sessions this run lost to provider infrastructure before giving up (omitted when none). */
  infraRetries?: number;
  /** Which fault they were lost to — an outage reads differently from a code problem. */
  infraSignature?: string;
  verifyCmd: string;
  runDir: string;
  phase?: 'implement' | 'review' | 'review-and-fix';
  reviewChangesRequested?: boolean | null;
  reviewSeverity?: string | null;
  issueStartSha?: string | null;
  endSha?: string | null;
  commits?: LoopCommitRecord[];
  usage?: StageUsage[];
};

/**
 * Write the run's `summary.json` and append it to `.loop/runs.jsonl` under
 * `root` (the main repo). Also echoes the per-stage token-usage table when
 * any usage was recorded.
 */
export function recordRun(
  ctx: RunContext,
  root: string,
  partial: Partial<RunRecord> & { outcome: string },
): RunRecord {
  mkdirSync(loopDir(root), { recursive: true });

  const record: RunRecord = {
    runId: ctx.runId,
    startedAt: ctx.startedAt,
    endedAt: new Date().toISOString(),
    issueId: ctx.issue.qualifiedId,
    issueFile: ctx.issue.relPath,
    issueTitle: ctx.issue.title,
    iteration: ctx.iteration,
    model: partial.model ?? 'auto',
    outcome: partial.outcome,
    agentOk: partial.agentOk ?? false,
    verifyOk: partial.verifyOk ?? null,
    issueDone: partial.issueDone ?? false,
    usageLimited: partial.usageLimited ?? false,
    stuckReason: partial.stuckReason ?? null,
    verifyCmd: partial.verifyCmd ?? '',
    runDir: path.relative(root, ctx.runDir),
    issueStartSha: ctx.issueStartSha,
    endSha: getHeadSha(ctx.workRoot),
    commits: ctx.commits,
    usage: ctx.usageEntries,
  };
  if (partial.infraRetries !== undefined) record.infraRetries = partial.infraRetries;
  if (partial.infraSignature !== undefined) record.infraSignature = partial.infraSignature;
  if (partial.phase !== undefined) record.phase = partial.phase;
  if (partial.reviewChangesRequested !== undefined) record.reviewChangesRequested = partial.reviewChangesRequested;
  if (partial.reviewSeverity !== undefined) record.reviewSeverity = partial.reviewSeverity;

  writeFileSync(ctx.summaryPath, `${JSON.stringify(record, null, 2)}\n`);
  appendFileSync(runsIndexPath(root), `${JSON.stringify(record)}\n`);
  if (ctx.usageEntries.length > 0) {
    console.log(`\n[loop] token usage for ${ctx.issue.qualifiedId}:\n${formatUsageTable(ctx.usageEntries)}`);
  }
  return record;
}

/**
 * Terminal bookkeeping for an interrupted run: mark the issue
 * `agentInterrupted` and record the run with an `interrupted` outcome.
 */
export function recordInterruptedRun(ctx: RunContext, root: string, labels: TriageLabels): void {
  setIssueTriage(ctx.issue, 'agentInterrupted', labels);
  recordRun(ctx, root, {
    outcome: 'interrupted',
    agentOk: false,
    verifyOk: null,
    issueDone: false,
    stuckReason: 'interrupted',
    verifyCmd: '',
  });
}

/** Print every recorded run from `.loop/runs.jsonl` (the `loop list-runs` view). */
export function listRuns(root: string): void {
  const indexPath = runsIndexPath(root);
  if (!existsSync(indexPath)) {
    console.log('No runs recorded yet. Logs are written under .loop/runs/ on each loop invocation.');
    return;
  }

  const lines = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean);
  console.log(`Recorded runs (${lines.length}):\n`);
  for (const line of lines) {
    try {
      const run = JSON.parse(line) as RunRecord;
      console.log(
        `${run.startedAt}  ${run.issueId.padEnd(24)}  ${run.outcome.padEnd(22)}  ${run.runDir}`,
      );
    } catch {
      console.log(line);
    }
  }
  console.log(`\nIndex: .loop/runs.jsonl`);
  console.log(`Artifacts: .loop/runs/<project>/<timestamp>-<issue-id>/`);
}
