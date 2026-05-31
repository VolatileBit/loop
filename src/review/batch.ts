/**
 * Batch review (`loop review [--fix]`): target selection plus the per-issue
 * review / review-and-fix orchestration driven by commands/review.ts.
 *
 * `--ids` / `--until` / `--file` entries resolve via issues/resolve-issue-ref
 * so both qualified `project/id` form and unambiguous bare-id shorthand work.
 *
 * Per-issue outcomes are returned as structured values (never process.exit)
 * so the command layer can decide between today's serial fail-fast behavior
 * and parallel worker-pool collection.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAgentStage } from '../agent/after-stage.js';
import { agentStageUsageEntries } from '../agent/usage.js';
import { extractAgentResultText } from '../agent/run-agent.js';
import { resolveProjectVerifyCmd } from '../config/project-settings.js';
import { ensureProjectNotes } from '../handoff/project-notes.js';
import type { StageCliFlags } from '../config/stage-settings.js';
import type { TriageLabels } from '../config/triage-labels.js';
import type { LoopConfig } from '../config/types.js';
import { logLoopCommit } from '../git/log-commit.js';
import { listDirtyPaths } from '../git/status.js';
import { readHandoff, recordHandoffFallbackCommit } from '../handoff/handoff.js';
import { escalateIssueForHuman, printHumanInterventionRequired } from '../issues/escalation.js';
import { resolveIssueRef } from '../issues/resolve-issue-ref.js';
import type { IssueRecord } from '../issues/types.js';
import { resolvePipelineDeps, type PipelineDeps } from '../pipeline/deps.js';
import { formatUsageTable, type StageUsage } from '../usage/tokens.js';
import {
  printVerifyFailureSummary,
  recordSkippedVerify,
  verifySatisfiedInSession,
} from '../verify/run-verify.js';
import { executeVerifyFixLoop } from '../verify/verify-fix-loop.js';
import { appendNits } from './nits.js';
import {
  missingFixCoverageFamilies,
  summarizeReviewConvergence,
  writeFixCoverageArtifact,
} from './convergence.js';
import { buildImplementPrompt, type PromptContext } from './prompts.js';
import { runReviewSession } from './run-review-session.js';
import {
  isReviewSatisfied,
  reviewFixAttemptsExhausted,
  reviewRequiresFix,
} from './verdict.js';

export function compareQualifiedIds(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

export type ReviewTargetOptions = {
  ids?: string[];
  until?: string | null;
  file?: string | null;
};

function parseReviewIdList(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Resolve `--ids` / `--until` / `--file` into a sorted, de-duplicated target
 * list. Every reference accepts a qualified `project/id` or an unambiguous bare
 * local id (via resolveIssueRef); unknown/ambiguous references throw.
 */
export function resolveReviewTargets(issues: IssueRecord[], options: ReviewTargetOptions): IssueRecord[] {
  const refs: string[] = [];

  if (options.file) {
    if (!existsSync(options.file)) {
      throw new Error(`Review file not found: ${options.file}`);
    }
    refs.push(...parseReviewIdList(readFileSync(options.file, 'utf8')));
  }

  if (options.ids?.length) {
    refs.push(...options.ids);
  }

  const targets = new Map<string, IssueRecord>();
  for (const ref of refs) {
    const issue = resolveIssueRef(ref, issues);
    targets.set(issue.qualifiedId, issue);
  }

  if (options.until) {
    const until = resolveIssueRef(options.until, issues);
    for (const issue of issues) {
      if (compareQualifiedIds(issue.qualifiedId, until.qualifiedId) <= 0) {
        targets.set(issue.qualifiedId, issue);
      }
    }
  }

  return [...targets.values()].sort((a, b) => compareQualifiedIds(a.qualifiedId, b.qualifiedId));
}

export type BatchReviewOptions = {
  config: LoopConfig;
  cliFlags?: StageCliFlags;
  labels: TriageLabels;
  /** Main repo root — `.loop/` bookkeeping. */
  root: string;
  /** Work root — agent/verify cwd. */
  cwd: string;
  /** Run the review↔fix machinery instead of a single review pass. */
  withFix: boolean;
  /** Required when withFix (commands/review.ts validates before calling). */
  verifyCmd: string | null;
  liveOutput?: boolean;
  promptContext?: PromptContext;
  deps?: Partial<PipelineDeps>;
};

export type BatchReviewOutcome =
  /** Review passed (or nits-only). */
  | { status: 'satisfied' }
  /** Review-only mode found blocking issues — surfaced, not fixed. */
  | { status: 'blocking'; runDir: string }
  /** Fix mode exhausted its cycles — issue escalated to needs-human. */
  | { status: 'escalated'; runDir: string }
  /** The batch cannot sensibly continue (usage limit, interrupted, agent failure). */
  | { status: 'fatal'; reason: string; code?: number; details?: string[] };

/** One batch target's full review (and optional fix) flow. */
export async function reviewIssueInBatch(
  issue: IssueRecord,
  options: BatchReviewOptions,
): Promise<BatchReviewOutcome> {
  const deps = resolvePipelineDeps(options.deps);
  const { config, root, cwd } = options;
  const preExistingDirtyPaths = listDirtyPaths(cwd);
  const issueUsage: StageUsage[] = [];
  // Per-project verify command (the projects map wins over the batch-wide one).
  const issueVerifyCmd = resolveProjectVerifyCmd(config, issue.project) ?? options.verifyCmd;
  const promptContext = options.promptContext
    ? {
        ...options.promptContext,
        verifyCmd: issueVerifyCmd,
        projectNotesPath: ensureProjectNotes(root, issue.project),
      }
    : undefined;

  const finish = (outcome: BatchReviewOutcome): BatchReviewOutcome => {
    if (issueUsage.length > 0) {
      console.log(`\n[loop] token usage for ${issue.qualifiedId}:\n${formatUsageTable(issueUsage)}`);
    }
    return outcome;
  };

  const sessionOptions = {
    config,
    cliFlags: options.cliFlags ?? {},
    root,
    cwd,
    standalone: true as const,
    liveOutput: options.liveOutput ?? true,
    ...(promptContext ? { promptContext } : {}),
    deps,
  };

  if (!options.withFix) {
    const review = await runReviewSession(issue, { ...sessionOptions, round: 1 });
    issueUsage.push(...agentStageUsageEntries('review-round-1', review));
    if (review.usageLimited) {
      return finish({ status: 'fatal', reason: `usage limit hit during review of ${issue.qualifiedId}`, code: 2 });
    }
    if (review.stuckReason === 'interrupted') {
      return finish({ status: 'fatal', reason: `review session for ${issue.qualifiedId} was interrupted`, code: 130 });
    }
    if (!review.ok) {
      return finish({
        status: 'fatal',
        reason: `review session for ${issue.qualifiedId} failed to complete`,
        details: [`See ${review.runDir}/`],
      });
    }
    if (reviewRequiresFix(review.verdict)) {
      return finish({ status: 'blocking', runDir: review.runDir });
    }
    if (review.verdict.severity === 'nits-only') appendNits(root, issue, review.verdict, review.runDir);
    return finish({ status: 'satisfied' });
  }

  let fixAttempts = 0;
  let reviewRound = 0;

  while (true) {
    reviewRound += 1;
    const review = await runReviewSession(issue, { ...sessionOptions, round: reviewRound });
    issueUsage.push(
      ...agentStageUsageEntries(`review-round-${reviewRound}`, review),
    );

    if (review.usageLimited) {
      return finish({
        status: 'fatal',
        reason: `usage limit hit during review of ${issue.qualifiedId}`,
        code: 2,
      });
    }
    if (review.stuckReason === 'interrupted') {
      return finish({ status: 'fatal', reason: `review session for ${issue.qualifiedId} was interrupted`, code: 130 });
    }
    if (!review.ok) {
      return finish({
        status: 'fatal',
        reason: `review session for ${issue.qualifiedId} failed to complete`,
        details: [`See ${review.runDir}/`],
      });
    }

    if (isReviewSatisfied(review.verdict)) {
      if (review.verdict.severity === 'nits-only') appendNits(root, issue, review.verdict, review.runDir);
      return finish({ status: 'satisfied' });
    }
    if (!reviewRequiresFix(review.verdict)) {
      return finish({ status: 'satisfied' });
    }

    if (reviewFixAttemptsExhausted(fixAttempts, config.maxReviewCycles)) {
      const convergence = summarizeReviewConvergence(review.history);
      escalateIssueForHuman(issue, review.verdict, {
        artifactDir: review.runDir,
        maxCycles: config.maxReviewCycles,
        labels: options.labels,
        root,
        convergence,
      });
      logLoopCommit(null, issue.qualifiedId, 'escalate', {
        cwd,
        excludePaths: config.commitExcludePaths,
        preservePaths: preExistingDirtyPaths,
        runDir: review.runDir,
      });
      printHumanInterventionRequired(issue, review.verdict, {
        artifactDir: review.runDir,
        labels: options.labels,
        root,
        convergence,
      });
      return finish({ status: 'escalated', runDir: review.runDir });
    }

    fixAttempts += 1;
    console.log(
      `\n[loop] review↔implement cycle ${fixAttempts}/${config.maxReviewCycles} — fix pass for ${issue.qualifiedId}`,
    );
    const fixDir = `${review.runDir}-fix-${fixAttempts}`;
    mkdirSync(fixDir, { recursive: true });
    const fixPrompt = buildImplementPrompt(
      issue,
      {
        reviewFeedback: { body: review.verdict.body, round: fixAttempts, history: review.history },
        handoff: readHandoff(root, issue),
      },
      promptContext,
    );
    writeFileSync(path.join(fixDir, 'prompt.md'), `${fixPrompt}\n`);
    const fixResult = await deps.runAgent(fixPrompt, {
      config,
      cliFlags: options.cliFlags ?? {},
      stage: 'reviewFix',
      cwd,
      logPath: path.join(fixDir, 'fix.stream.log'),
      stageLabel: `${issue.qualifiedId}-review-fix-${fixAttempts}`,
      liveOutput: options.liveOutput ?? true,
    });
    issueUsage.push(
      ...agentStageUsageEntries(`review-fix-${fixAttempts}`, fixResult),
    );

    if (fixResult.usageLimited) {
      return finish({
        status: 'fatal',
        reason: `usage limit hit during review-fix pass ${fixAttempts} for ${issue.qualifiedId}`,
        code: 2,
      });
    }
    if (fixResult.stuckReason === 'interrupted') {
      return finish({
        status: 'fatal',
        reason: `review-fix pass ${fixAttempts} for ${issue.qualifiedId} was interrupted`,
        code: 130,
      });
    }
    if (fixResult.stuckReason || !fixResult.ok) {
      return finish({
        status: 'fatal',
        reason: `review-fix pass ${fixAttempts} for ${issue.qualifiedId} failed`,
        details: [`Reason: ${fixResult.stuckReason ?? 'agent-failed'}`, `See ${fixDir}/`],
      });
    }

    const suggestion = afterAgentStage(fixResult, root, issue);
    const coverageArtifactPath = path.join(fixDir, 'fix.coverage.json');
    const coverage = writeFixCoverageArtifact(coverageArtifactPath, {
      issueId: issue.qualifiedId,
      round: fixAttempts,
      agentText: extractAgentResultText(fixResult),
    });
    const fixCommit = logLoopCommit(null, issue.qualifiedId, `review-fix-${fixAttempts}`, {
      cwd,
      excludePaths: config.commitExcludePaths,
      preservePaths: preExistingDirtyPaths,
      runDir: fixDir,
      suggestion,
    });
    recordHandoffFallbackCommit(root, issue, fixCommit);
    const missingCoverageFamilies = missingFixCoverageFamilies(
      coverage,
      review.verdict.findingFamilies,
    );
    if (missingCoverageFamilies.length > 0) {
      return finish({
        status: 'fatal',
        reason: `review-fix pass ${fixAttempts} for ${issue.qualifiedId} has missing or incomplete Loop fix coverage`,
        details: [
          `Missing/incomplete families: ${missingCoverageFamilies.map((id) => `\`${id}\``).join(', ')}`,
          `See ${coverageArtifactPath}`,
        ],
      });
    }

    const verifyCmd = issueVerifyCmd;
    if (!verifyCmd) {
      return finish({
        status: 'fatal',
        reason: 'no verify command configured for the review fix loop',
        details: ['Set `verifyCmd` in loop.config.json or pass --verify-cmd.'],
      });
    }
    // The fix session's own stream may already have proven the gate.
    const initialVerify = verifySatisfiedInSession(fixResult.provenCommands, verifyCmd)
      ? recordSkippedVerify(verifyCmd, path.join(fixDir, 'verify.log'))
      : await deps.runVerifyCommand(verifyCmd, cwd, path.join(fixDir, 'verify.log'), {
          stageLabel: `${issue.qualifiedId}-review-fix-${fixAttempts}`,
          heartbeatIntervalMs: config.heartbeatIntervalMs,
        });
    const verifyLoop = await executeVerifyFixLoop(issue, initialVerify, {
      config,
      cliFlags: options.cliFlags ?? {},
      verifyCmd,
      root,
      cwd,
      runDir: fixDir,
      artifactScope: `fix-${fixAttempts}`,
      commitCtx: null,
      liveOutput: options.liveOutput ?? true,
      ...(promptContext ? { promptContext } : {}),
      deps,
    });
    if (!verifyLoop.ok) {
      if (verifyLoop.outcome === 'verify-failed' && verifyLoop.verify) {
        printVerifyFailureSummary(verifyLoop.verify, config.maxVerifyCycles);
      }
      return finish({
        status: 'fatal',
        reason: `verify fix loop stopped for ${issue.qualifiedId} after review-fix pass ${fixAttempts}`,
        details: [`Outcome: ${verifyLoop.outcome}`, `See ${fixDir}/`],
      });
    }
  }
}
