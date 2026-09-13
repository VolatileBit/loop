/**
 * One review agent session: build the review prompt (config-driven skill +
 * spec context), run the `review`-stage agent, parse the verdict, and persist
 * review artifacts. Provider-agnostic and per-worker (explicit root/cwd).
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  extractAgentResultText,
  type AgentAttemptTelemetry,
  type AgentStuckReason,
} from '../agent/run-agent.js';
import type { UsageLimitDetails } from '../agent/providers/usage-limit.js';
import type { StageCliFlags } from '../config/stage-settings.js';
import type { AgentCli, LoopConfig } from '../config/types.js';
import { resolveIssueReviewFixedPoint } from '../git/fixed-point.js';
import { isGitRepository } from '../git/status.js';
import { resolveIssueSpec } from '../issues/resolve-spec.js';
import type { IssueRecord } from '../issues/types.js';
import { formatRunTimestamp } from '../logs/run-context.js';
import { badge } from '../logs/style.js';
import { resolvePipelineDeps, type PipelineDeps } from '../pipeline/deps.js';
import { loopDir, reviewsIndexPath, runsDir } from '../shared/paths.js';
import type { AgentUsage } from '../usage/tokens.js';
import {
  appendReviewToHistory,
  loadReviewConvergenceHistory,
  type ReviewConvergenceHistory,
} from './convergence.js';
import { buildReviewPrompt, type PromptContext } from './prompts.js';
import {
  parseReviewVerdict,
  reviewVerdictContractError,
  type ReviewVerdict,
} from './verdict.js';

export function warnIfReviewDiffLimited(cwd: string): void {
  if (!isGitRepository(cwd)) {
    console.warn('[loop] workspace is not a git repository — review diff may be limited.');
  }
}

export type ReviewSessionResult = {
  ok: boolean;
  verdict: ReviewVerdict;
  runDir: string;
  usageLimited: boolean;
  usageLimitDetails: UsageLimitDetails | null;
  /** The CLI session id (best-effort) — feeds a resume after a usage-limit wait. */
  sessionId: string | null;
  stuckReason: AgentStuckReason;
  usage: AgentUsage | null;
  /** Dollar cost as reported by the CLI; null when the CLI reports none. */
  costUsd: number | null;
  agentCli: AgentCli;
  model: string;
  /** Wall time of the review session (see AgentRunResult.elapsedMs). */
  elapsedMs: number;
  /** Largest measured single-request context, or null when the CLI reports none. */
  peakContextTokens: number | null;
  attempts?: AgentAttemptTelemetry[];
  /** Prior review/fix artifacts plus this completed review. */
  history: ReviewConvergenceHistory;
};

export type ReviewSessionOptions = {
  config: LoopConfig;
  cliFlags?: StageCliFlags;
  /** Main repo root — `.loop/` run dirs and indexes live here. */
  root: string;
  /** Work root — agent cwd and git fixed-point resolution. */
  cwd: string;
  round: number;
  /** Standalone sessions get their own run dir + reviews.jsonl entry; nested ones live under the parent run dir. */
  standalone: boolean;
  parentRunDir?: string;
  /** Explicit fixed point (the run's issue-start SHA), if known. */
  fixedPoint?: string | null;
  liveOutput?: boolean;
  /** Environment for the review session (see resolveProjectEnv). */
  env?: NodeJS.ProcessEnv;
  promptContext?: PromptContext;
  /** Resume a previous (usage-limited) review session instead of starting fresh. */
  resume?: { sessionId: string } | null;
  /** Test/advanced override; normal sessions load all prior issue artifacts from disk. */
  history?: ReviewConvergenceHistory;
  deps?: Partial<PipelineDeps>;
};

export function buildReviewPromptForIssue(
  issue: IssueRecord,
  options: Pick<
    ReviewSessionOptions,
    'config' | 'cwd' | 'root' | 'round' | 'fixedPoint' | 'promptContext' | 'history'
  >,
): string {
  const fixedPoint = resolveIssueReviewFixedPoint(issue.qualifiedId, options.fixedPoint, options.cwd);
  const context: PromptContext = options.promptContext ?? {
    reviewSkill: options.config.reviewSkill,
    specRelPath: resolveIssueSpec(issue, options.config, options.cwd, options.root),
  };
  return buildReviewPrompt(
    issue,
    {
      round: options.round,
      fixedPoint,
      ...(options.history ? { history: options.history } : {}),
    },
    context,
  );
}

export async function runReviewSession(
  issue: IssueRecord,
  options: ReviewSessionOptions,
): Promise<ReviewSessionResult> {
  const deps = resolvePipelineDeps(options.deps);
  const { config, root, cwd, round, standalone } = options;
  const startedAt = new Date();
  const runDir = standalone
    ? path.join(runsDir(root), issue.project, `${formatRunTimestamp(startedAt)}-${issue.id}-review`)
    : path.join(options.parentRunDir!, 'reviews', `round-${round}`);
  const priorHistory =
    options.history ??
    loadReviewConvergenceHistory(root, {
      project: issue.project,
      qualifiedId: issue.qualifiedId,
    });

  mkdirSync(runDir, { recursive: true });
  const prompt = buildReviewPromptForIssue(issue, { ...options, history: priorHistory });
  writeFileSync(path.join(runDir, 'prompt.md'), `${prompt}\n`);
  writeFileSync(
    path.join(runDir, 'review-context.json'),
    `${JSON.stringify(
      {
        issueId: issue.qualifiedId,
        round,
        fixedPoint: options.fixedPoint ?? null,
        priorReviewCount: priorHistory.reviews.length,
        endedAt: null,
      },
      null,
      2,
    )}\n`,
  );

  const stageLabel = `${issue.qualifiedId}-review-round-${round}`;
  console.log(`\n[loop] review session round ${round} → ${path.relative(root, runDir)}/`);
  const agentResult = await deps.runAgent(prompt, {
    config,
    cliFlags: options.cliFlags ?? {},
    stage: 'review',
    project: issue.project,
    cwd,
    logPath: path.join(runDir, 'review.stream.log'),
    stageLabel,
    liveOutput: options.liveOutput ?? true,
    ...(options.env ? { env: options.env } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
  });
  const text = extractAgentResultText(agentResult);
  const verdict = parseReviewVerdict(text);
  const contractError = reviewVerdictContractError(verdict);
  /**
   * Whether a reviewer actually spoke. A session killed by a usage limit, an
   * interrupt or a timeout leaves nothing to parse, and `parseReviewVerdict`
   * answers an empty body with its safe default — changes requested. That
   * default is right for the *pipeline* (never land on silence) but wrong to
   * print: "CHANGES REQUESTED · unknown" reads as the reviewer's judgement
   * rather than as loop never having heard one.
   */
  const reviewerSpoke = agentResult.ok && !agentResult.usageLimited && agentResult.stuckReason === null;
  const completed = reviewerSpoke && contractError === null;
  const endedAt = new Date().toISOString();
  const reviewArtifactPath = path.join(runDir, 'review.json');

  writeFileSync(path.join(runDir, 'review.md'), `${text}\n`);
  writeFileSync(
    reviewArtifactPath,
    `${JSON.stringify(
      { issueId: issue.qualifiedId, round, endedAt, completed, contractError, ...verdict },
      null,
      2,
    )}\n`,
  );
  const history = completed
    ? appendReviewToHistory(priorHistory, {
        issueId: issue.qualifiedId,
        round,
        endedAt,
        artifactPath: path.relative(root, reviewArtifactPath),
        verdict,
      })
    : priorHistory;

  if (standalone) {
    mkdirSync(loopDir(root), { recursive: true });
    appendFileSync(
      reviewsIndexPath(root),
      `${JSON.stringify({
        runId: path.basename(runDir),
        issueId: issue.qualifiedId,
        issueFile: issue.relPath,
        runDir: path.relative(root, runDir),
        changesRequested: verdict.changesRequested,
        severity: verdict.severity,
        summary: verdict.summary,
        endedAt,
      })}\n`,
    );
  }

  // The one line deciding this issue's fate, surrounded by blank lines so it
  // does not read as one more entry in the tool-call stream above it. A
  // malformed verdict still prints one — a reviewer that answered badly did
  // answer, and treating that as blocking is the deliberate safe reading.
  if (reviewerSpoke) {
    const tone = !verdict.changesRequested ? 'good' : verdict.severity === 'blocking' ? 'bad' : 'caution';
    const label = verdict.changesRequested ? `CHANGES REQUESTED · ${verdict.severity}` : 'APPROVED';
    console.log(`\n[loop] review verdict: ${badge(label, tone)} — ${verdict.summary}\n`);
  } else {
    const reason = agentResult.usageLimited
      ? 'the session hit a provider usage limit'
      : agentResult.stuckReason
        ? `the session ${agentResult.stuckReason}`
        : 'the session failed';
    console.log(`\n[loop] ${badge('NO REVIEW VERDICT', 'caution')} — ${reason}; nothing was judged.\n`);
  }
  if (contractError) {
    console.error(`[loop] invalid review output: ${contractError}.`);
  }

  return {
    ok: agentResult.ok && contractError === null,
    verdict,
    runDir,
    usageLimited: agentResult.usageLimited,
    usageLimitDetails: agentResult.usageLimitDetails,
    sessionId: agentResult.sessionId ?? null,
    stuckReason: agentResult.stuckReason,
    usage: agentResult.usage,
    costUsd: agentResult.costUsd,
    elapsedMs: agentResult.elapsedMs,
    peakContextTokens: agentResult.peakContextTokens,
    agentCli: agentResult.agentCli,
    model: agentResult.model,
    ...(agentResult.attempts ? { attempts: agentResult.attempts } : {}),
    history,
  };
}
