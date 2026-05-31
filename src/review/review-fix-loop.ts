/**
 * Review ↔ implement fix loop: run a review session; while it finds blocking
 * issues and cycles remain, run a `reviewFix` agent session against the
 * verdict, verify (with its own nested verify-fix loop), and re-review.
 *
 * Resume support: the blocking verdict is persisted to the issue's handoff
 * file (pending review feedback) whenever a fix pass is entered, and cleared
 * once a review round resolves. A `resumeAtFix` entry skips the leading
 * review call and builds the first fix prompt from that persisted feedback.
 *
 * Every failure outcome carries `stageAtFailure` (`review`, `reviewFix`, or
 * `verifyFix` from the nested loop) for the pipeline's resume checkpoint.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAgentStage } from '../agent/after-stage.js';
import { agentStageUsageEntries } from '../agent/usage.js';
import { extractAgentResultText } from '../agent/run-agent.js';
import type { UsageLimitDetails } from '../agent/providers/usage-limit.js';
import type { StageCliFlags } from '../config/stage-settings.js';
import type { LoopConfig, PipelineStageName } from '../config/types.js';
import { logLoopCommit } from '../git/log-commit.js';
import {
  clearPendingReviewFeedback,
  readHandoff,
  recordHandoffFallbackCommit,
  writePendingReviewFeedback,
} from '../handoff/handoff.js';
import { isParkRequested } from '../interrupt/shutdown.js';
import { discoverIssues } from '../issues/discovery.js';
import type { IssueRecord } from '../issues/types.js';
import type { RunContext } from '../logs/run-context.js';
import { resolvePipelineDeps, type PipelineDeps } from '../pipeline/deps.js';
import {
  recordSkippedVerify,
  verifySatisfiedInSession,
  type ShellVerifyResult,
} from '../verify/run-verify.js';
import { executeVerifyFixLoop } from '../verify/verify-fix-loop.js';
import { appendNits } from './nits.js';
import {
  loadReviewConvergenceHistory,
  missingFixCoverageFamilies,
  summarizeReviewConvergence,
  writeFixCoverageArtifact,
  type ReviewConvergenceHistory,
  type ReviewConvergenceSummary,
} from './convergence.js';
import { buildImplementPrompt, type PromptContext } from './prompts.js';
import { runReviewSession } from './run-review-session.js';
import {
  isReviewSatisfied,
  reviewFixAttemptsExhausted,
  reviewRequiresFix,
  type ReviewVerdict,
} from './verdict.js';

export type ReviewFixFailureOutcome =
  | 'usage-limit'
  /** Killed mid-session by a force-stop. */
  | 'interrupted'
  /** Stopped deliberately at a round boundary (ESC x2) — resumable, not a failure. */
  | 'parked'
  | 'review-failed'
  | 'fix-coverage-missing'
  | 'needs-human'
  | 'agent-failed'
  | 'wall-timeout'
  | 'idle-timeout'
  | 'verify-failed';

export type ReviewFixLoopResult =
  | { ok: true; verdict: ReviewVerdict }
  | {
      ok: false;
      outcome: ReviewFixFailureOutcome;
      stageAtFailure: PipelineStageName;
      verdict?: ReviewVerdict | undefined;
      verify?: ShellVerifyResult | undefined;
      /** Set on 'usage-limit' outcomes — which window was hit and when it lifts (best-effort). */
      usageLimitDetails?: UsageLimitDetails | undefined;
      /** The dead session's id on 'usage-limit' outcomes — feeds a resume after the wait. */
      usageLimitSessionId?: string | undefined;
      /** Root-cause recurrence summary when the review fix budget is exhausted. */
      convergence?: ReviewConvergenceSummary | undefined;
      missingCoverageFamilies?: string[] | undefined;
      coverageArtifactPath?: string | undefined;
    };

export type ReviewFixLoopOptions = {
  config: LoopConfig;
  cliFlags?: StageCliFlags;
  /** Resolved verify command for the nested verify-fix loops. */
  verifyCmd: string;
  /** Main repo root — handoffs / nits / run indexes. */
  root: string;
  /** Work root — agent cwd, verify cwd, issue re-discovery. */
  cwd: string;
  run: RunContext;
  liveOutput?: boolean;
  /** Called as each pipeline stage begins (pipeline wires this to setIssueStage + worker status). */
  onStage?: (stage: PipelineStageName, label: string) => void;
  /** Test seam: overrides the process-wide "stop at the next boundary" check. */
  parkRequested?: () => boolean;
  /** Environment for sessions and verify runs (see resolveProjectEnv). */
  env?: NodeJS.ProcessEnv;
  promptContext?: PromptContext;
  /**
   * Resume-at-fix entry: skip the leading review call and build the first fix
   * prompt from this feedback (read back from the handoff's pending section).
   */
  resumeAtFix?: { feedback: string } | null;
  /** Goal mode: re-read the declared verify command before every verify (see verify-fix-loop). */
  resolveVerifyCmd?: () => string | null;
  /** Resume a previous (usage-limited) review session on the first review round. */
  resumeReviewSession?: { sessionId: string } | null;
  /** Resume a previous (usage-limited) fix session on the first fix pass. */
  resumeFixSession?: { sessionId: string } | null;
  deps?: Partial<PipelineDeps>;
};

export async function executeReviewFixLoop(
  issue: IssueRecord,
  options: ReviewFixLoopOptions,
): Promise<ReviewFixLoopResult> {
  const deps = resolvePipelineDeps(options.deps);
  const { config, root, cwd, run, verifyCmd } = options;
  const parkRequested = options.parkRequested ?? isParkRequested;

  let currentIssue = issue;
  let fixAttempts = 0;
  let reviewRound = 0;
  let pendingFeedback: string | null = options.resumeAtFix?.feedback ?? null;
  let lastVerdict: ReviewVerdict | undefined;
  let history: ReviewConvergenceHistory = loadReviewConvergenceHistory(root, {
    project: issue.project,
    qualifiedId: issue.qualifiedId,
  });

  const fail = (
    outcome: ReviewFixFailureOutcome,
    stageAtFailure: PipelineStageName,
    extras: {
      verdict?: ReviewVerdict | undefined;
      verify?: ShellVerifyResult | undefined;
      usageLimitDetails?: UsageLimitDetails | undefined;
      usageLimitSessionId?: string | undefined;
      convergence?: ReviewConvergenceSummary | undefined;
      missingCoverageFamilies?: string[] | undefined;
      coverageArtifactPath?: string | undefined;
    } = {},
  ): ReviewFixLoopResult => ({ ok: false, outcome, stageAtFailure, ...extras });

  while (true) {
    if (pendingFeedback === null) {
      reviewRound += 1;
      options.onStage?.('review', `review-round-${reviewRound}`);
      const review = await runReviewSession(currentIssue, {
        config,
        cliFlags: options.cliFlags ?? {},
        root,
        cwd,
        round: reviewRound,
        standalone: false,
        parentRunDir: run.runDir,
        fixedPoint: run.issueStartSha,
        liveOutput: options.liveOutput ?? true,
        ...(options.env ? { env: options.env } : {}),
        ...(options.promptContext ? { promptContext: options.promptContext } : {}),
        ...(reviewRound === 1 && options.resumeReviewSession ? { resume: options.resumeReviewSession } : {}),
        deps,
      });

      run.usageEntries.push(
        ...agentStageUsageEntries(`review-round-${reviewRound}`, review),
      );

      if (review.usageLimited) {
        return fail('usage-limit', 'review', {
          usageLimitDetails: review.usageLimitDetails ?? undefined,
          usageLimitSessionId: review.sessionId ?? undefined,
        });
      }
      if (review.stuckReason === 'interrupted') return fail('interrupted', 'review');
      if (!review.ok) return fail('review-failed', 'review');

      lastVerdict = review.verdict;
      history = review.history;

      if (isReviewSatisfied(review.verdict)) {
        if (review.verdict.severity === 'nits-only') appendNits(root, currentIssue, review.verdict, review.runDir);
        clearPendingReviewFeedback(root, issue);
        return { ok: true, verdict: review.verdict };
      }

      if (!reviewRequiresFix(review.verdict)) {
        clearPendingReviewFeedback(root, issue);
        return { ok: true, verdict: review.verdict };
      }

      // Blocking verdict — persist it so a crash/kill before the fix pass
      // finishes (or a needs-human unblock) can resume straight into reviewFix.
      writePendingReviewFeedback(root, issue, review.verdict.body);

      if (reviewFixAttemptsExhausted(fixAttempts, config.maxReviewCycles)) {
        return fail('needs-human', 'reviewFix', {
          verdict: review.verdict,
          convergence: summarizeReviewConvergence(history),
        });
      }

      // Boundary: a review found blocking work. The findings are already
      // persisted above, so a resume re-enters straight at the fix pass rather
      // than paying for a second review of the same tree.
      if (parkRequested()) return fail('parked', 'reviewFix', { verdict: review.verdict });

      pendingFeedback = review.verdict.body;
    }

    fixAttempts += 1;
    options.onStage?.('reviewFix', `review-fix-${fixAttempts}`);
    console.log(
      `\n[loop] review↔implement cycle ${fixAttempts}/${config.maxReviewCycles} — implementation fix pass`,
    );

    const fixPrompt = buildImplementPrompt(
      currentIssue,
      {
        reviewFeedback: { body: pendingFeedback, round: fixAttempts, history },
        handoff: readHandoff(root, issue),
      },
      options.promptContext,
    );
    writeFileSync(path.join(run.runDir, `fix-${fixAttempts}.prompt.md`), `${fixPrompt}\n`);

    const fixResult = await deps.runAgent(fixPrompt, {
      config,
      cliFlags: options.cliFlags ?? {},
      stage: 'reviewFix',
      project: issue.project,
      cwd,
      logPath: path.join(run.runDir, `fix-${fixAttempts}.stream.log`),
      stageLabel: `${issue.qualifiedId}-review-fix-${fixAttempts}`,
      liveOutput: options.liveOutput ?? true,
      ...(options.env ? { env: options.env } : {}),
      ...(fixAttempts === 1 && options.resumeFixSession ? { resume: options.resumeFixSession } : {}),
    });
    run.usageEntries.push(
      ...agentStageUsageEntries(`review-fix-${fixAttempts}`, fixResult),
    );

    if (fixResult.usageLimited) {
      return fail('usage-limit', 'reviewFix', {
        verdict: lastVerdict,
        usageLimitDetails: fixResult.usageLimitDetails ?? undefined,
        usageLimitSessionId: fixResult.sessionId ?? undefined,
      });
    }
    if (fixResult.stuckReason === 'interrupted') return fail('interrupted', 'reviewFix', { verdict: lastVerdict });
    if (fixResult.stuckReason) return fail(fixResult.stuckReason, 'reviewFix', { verdict: lastVerdict });
    if (!fixResult.ok) return fail('agent-failed', 'reviewFix', { verdict: lastVerdict });

    const suggestion = afterAgentStage(fixResult, root, issue);
    const coverageArtifactPath = path.join(run.runDir, `fix-${fixAttempts}.coverage.json`);
    const coverage = writeFixCoverageArtifact(coverageArtifactPath, {
      issueId: issue.qualifiedId,
      round: fixAttempts,
      agentText: extractAgentResultText(fixResult),
    });
    const fixCommit = logLoopCommit(run, currentIssue.qualifiedId, `review-fix-${fixAttempts}`, {
      cwd,
      excludePaths: config.commitExcludePaths,
      suggestion,
    });
    recordHandoffFallbackCommit(root, issue, fixCommit);
    const expectedFamilies =
      lastVerdict?.findingFamilies ??
      history.reviews.at(-1)?.findingFamilies ??
      [];
    const missingCoverageFamilies = missingFixCoverageFamilies(coverage, expectedFamilies);
    if (missingCoverageFamilies.length > 0) {
      return fail('fix-coverage-missing', 'reviewFix', {
        verdict: lastVerdict,
        missingCoverageFamilies,
        coverageArtifactPath,
      });
    }

    // The fix session's own stream may already have proven the gate. Re-resolve
    // first: a goal fix session may have corrected the declared command.
    const currentVerifyCmd = options.resolveVerifyCmd?.() ?? verifyCmd;
    const fixVerifyLogPath = path.join(run.runDir, `fix-${fixAttempts}.verify.log`);
    const initialVerify = verifySatisfiedInSession(fixResult.provenCommands, currentVerifyCmd)
      ? recordSkippedVerify(currentVerifyCmd, fixVerifyLogPath)
      : await deps.runVerifyCommand(currentVerifyCmd, cwd, fixVerifyLogPath, {
          stageLabel: `${issue.qualifiedId}-review-fix-${fixAttempts}`,
          heartbeatIntervalMs: config.heartbeatIntervalMs,
          ...(options.env ? { env: options.env } : {}),
        });
    const verifyLoop = await executeVerifyFixLoop(currentIssue, initialVerify, {
      config,
      cliFlags: options.cliFlags ?? {},
      verifyCmd: currentVerifyCmd,
      root,
      cwd,
      runDir: run.runDir,
      artifactScope: `fix-${fixAttempts}`,
      commitCtx: run,
      liveOutput: options.liveOutput ?? true,
      parkRequested,
      ...(options.env ? { env: options.env } : {}),
      ...(options.onStage ? { onStage: options.onStage } : {}),
      ...(options.promptContext ? { promptContext: options.promptContext } : {}),
      ...(options.resolveVerifyCmd ? { resolveVerifyCmd: options.resolveVerifyCmd } : {}),
      deps,
    });
    if (!verifyLoop.ok) {
      return fail(verifyLoop.outcome, verifyLoop.stageAtFailure, {
        verdict: lastVerdict,
        verify: verifyLoop.verify,
        usageLimitDetails: verifyLoop.usageLimitDetails,
        usageLimitSessionId: verifyLoop.usageLimitSessionId,
      });
    }

    currentIssue =
      discoverIssues(config.issuesDir, cwd).find((item) => item.qualifiedId === issue.qualifiedId) ??
      currentIssue;
    // This fix round is complete — the next iteration re-reviews fresh.
    pendingFeedback = null;

    // Boundary: the fix landed and its gate passed; only a fresh review round
    // remains, so a resume enters at `review` with nothing lost.
    if (parkRequested()) return fail('parked', 'review', { verdict: lastVerdict });
  }
}
