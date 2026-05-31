/**
 * Verify ↔ implement fix loop: while the external verify command fails, run
 * a `verifyFix` agent session against the failure output, commit, re-verify —
 * up to `maxVerifyCycles` passes. Provider-agnostic (per-stage settings via
 * runAgent) and per-worker (explicit root/cwd, no globals).
 *
 * Every failure outcome carries `stageAtFailure` so the pipeline's resume
 * checkpoint can record precisely where the issue stopped.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAgentStage } from '../agent/after-stage.js';
import { agentStageUsageEntries } from '../agent/usage.js';
import type { UsageLimitDetails } from '../agent/providers/usage-limit.js';
import type { StageCliFlags } from '../config/stage-settings.js';
import type { LoopConfig, PipelineStageName } from '../config/types.js';
import { logLoopCommit } from '../git/log-commit.js';
import { readHandoff, recordHandoffFallbackCommit } from '../handoff/handoff.js';
import { isParkRequested } from '../interrupt/shutdown.js';
import { discoverIssues } from '../issues/discovery.js';
import type { IssueRecord } from '../issues/types.js';
import type { RunContext } from '../logs/run-context.js';
import { resolvePipelineDeps, type PipelineDeps } from '../pipeline/deps.js';
import { buildImplementPrompt, type PromptContext } from '../review/prompts.js';
import { verifyFixAttemptsExhausted } from '../review/verdict.js';
import type { StageUsage } from '../usage/tokens.js';
import {
  extractVerifyFailures,
  recordSkippedVerify,
  verifySatisfiedInSession,
  type ShellVerifyResult,
} from './run-verify.js';

export type VerifyFixFailureOutcome =
  | 'verify-failed'
  | 'usage-limit'
  /** Killed mid-session by a force-stop. */
  | 'interrupted'
  /** Stopped deliberately at a cycle boundary (ESC x2) — resumable, not a failure. */
  | 'parked'
  | 'wall-timeout'
  | 'idle-timeout'
  | 'agent-failed';

export type VerifyFixLoopResult =
  | { ok: true; verify: ShellVerifyResult }
  | {
      ok: false;
      outcome: VerifyFixFailureOutcome;
      stageAtFailure: PipelineStageName;
      verify?: ShellVerifyResult | undefined;
      /** Set on 'usage-limit' outcomes — which window was hit and when it lifts (best-effort). */
      usageLimitDetails?: UsageLimitDetails | undefined;
      /** The dead session's id on 'usage-limit' outcomes — feeds a resume after the wait. */
      usageLimitSessionId?: string | undefined;
    };

export type VerifyFixLoopOptions = {
  config: LoopConfig;
  cliFlags?: StageCliFlags;
  /** Resolved verify command (callers fail fast before here when unset). */
  verifyCmd: string;
  /** Main repo root — `.loop/` bookkeeping (handoffs) lives here. */
  root: string;
  /** Work root — agent cwd, verify cwd, and issue re-discovery. */
  cwd: string;
  /** Artifact directory for this loop's prompts/logs. */
  runDir: string;
  /** Artifact filename prefix, e.g. `fix-2` when nested in a review-fix pass. */
  artifactScope?: string;
  /** Run context for commit records + usage; null for standalone (batch review) loops. */
  commitCtx?: RunContext | null;
  /** Usage sink override; defaults to `commitCtx?.usageEntries`. */
  usageSink?: StageUsage[] | null;
  liveOutput?: boolean;
  /** Called as each pipeline stage begins (pipeline wires this to setIssueStage + worker status). */
  onStage?: (stage: PipelineStageName, label: string) => void;
  promptContext?: PromptContext;
  /**
   * Goal mode: re-read the declared verify command before every cycle (fix
   * sessions may correct a wrong declaration). Falls back to `verifyCmd` when
   * unset or when the declaration disappears mid-loop.
   */
  resolveVerifyCmd?: () => string | null;
  /** Resume a previous (usage-limited) fix session on the first cycle instead of starting fresh. */
  resumeFirstSession?: { sessionId: string } | null;
  /** Test seam: overrides the process-wide "stop at the next boundary" check. */
  parkRequested?: () => boolean;
  /** Environment for sessions and verify runs (see resolveProjectEnv). */
  env?: NodeJS.ProcessEnv;
  deps?: Partial<PipelineDeps>;
};

export async function executeVerifyFixLoop(
  issue: IssueRecord,
  initialVerify: ShellVerifyResult,
  options: VerifyFixLoopOptions,
): Promise<VerifyFixLoopResult> {
  const deps = resolvePipelineDeps(options.deps);
  const { config, root, cwd, runDir, verifyCmd } = options;
  const commitCtx = options.commitCtx ?? null;
  const usageSink = options.usageSink !== undefined ? options.usageSink : (commitCtx?.usageEntries ?? null);
  const artifactScope = options.artifactScope ?? '';
  const parkRequested = options.parkRequested ?? isParkRequested;
  const failure = (
    outcome: VerifyFixFailureOutcome,
    verify?: ShellVerifyResult,
    usageLimitDetails?: UsageLimitDetails | null,
    usageLimitSessionId?: string | null,
  ): VerifyFixLoopResult => ({
    ok: false,
    outcome,
    stageAtFailure: 'verifyFix',
    ...(verify ? { verify } : {}),
    ...(usageLimitDetails ? { usageLimitDetails } : {}),
    ...(usageLimitSessionId ? { usageLimitSessionId } : {}),
  });

  let verify = initialVerify;
  let fixAttempts = 0;
  let currentIssue = issue;

  while (!verify.ok) {
    if (verifyFixAttemptsExhausted(fixAttempts, config.maxVerifyCycles)) {
      return failure('verify-failed', verify);
    }

    fixAttempts += 1;
    const prefix = artifactScope ? `${artifactScope}.verify-fix-${fixAttempts}` : `verify-fix-${fixAttempts}`;
    options.onStage?.('verifyFix', `verify-fix-${fixAttempts}`);
    // Goal mode re-reads the declaration each cycle; feature mode keeps the fixed command.
    const currentVerifyCmd = options.resolveVerifyCmd?.() ?? verifyCmd;

    console.log(
      `\n[loop] verify↔implement cycle ${fixAttempts}/${config.maxVerifyCycles} — fix failing tests/types`,
    );

    const fixPrompt = buildImplementPrompt(
      currentIssue,
      {
        verifyFeedback: {
          round: fixAttempts,
          cmd: currentVerifyCmd,
          output: verify.output,
          failures: extractVerifyFailures(verify.output),
        },
        handoff: readHandoff(root, issue),
      },
      options.promptContext,
    );
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, `${prefix}.prompt.md`), `${fixPrompt}\n`);

    const fixResult = await deps.runAgent(fixPrompt, {
      config,
      cliFlags: options.cliFlags ?? {},
      stage: 'verifyFix',
      project: issue.project,
      cwd,
      logPath: path.join(runDir, `${prefix}.stream.log`),
      stageLabel: `${issue.qualifiedId}-${prefix}`,
      liveOutput: options.liveOutput ?? true,
      ...(options.env ? { env: options.env } : {}),
      ...(fixAttempts === 1 && options.resumeFirstSession ? { resume: options.resumeFirstSession } : {}),
    });
    if (usageSink) {
      usageSink.push(...agentStageUsageEntries(prefix, fixResult));
    }

    if (fixResult.usageLimited) {
      return failure('usage-limit', undefined, fixResult.usageLimitDetails, fixResult.sessionId ?? null);
    }
    if (fixResult.stuckReason === 'interrupted') return failure('interrupted');
    if (fixResult.stuckReason) return failure(fixResult.stuckReason);
    if (!fixResult.ok) return failure('agent-failed');

    const suggestion = afterAgentStage(fixResult, root, issue);
    const fixCommit = logLoopCommit(commitCtx, issue.qualifiedId, `verify-fix-${fixAttempts}`, {
      cwd,
      excludePaths: config.commitExcludePaths,
      runDir: commitCtx ? undefined : runDir,
      suggestion,
    });
    recordHandoffFallbackCommit(root, issue, fixCommit);

    currentIssue =
      discoverIssues(config.issuesDir, cwd).find((item) => item.qualifiedId === issue.qualifiedId) ??
      currentIssue;
    // The fix session's own stream may already have proven the gate — exactly
    // one full-suite execution per cycle, whichever side ran it. Re-resolve
    // first: the fix session may have corrected a goal declaration.
    const recheckCmd = options.resolveVerifyCmd?.() ?? currentVerifyCmd;
    verify = verifySatisfiedInSession(fixResult.provenCommands, recheckCmd)
      ? recordSkippedVerify(recheckCmd, path.join(runDir, `${prefix}.verify.log`))
      : await deps.runVerifyCommand(recheckCmd, cwd, path.join(runDir, `${prefix}.verify.log`), {
          stageLabel: `${issue.qualifiedId}-${prefix}`,
          heartbeatIntervalMs: config.heartbeatIntervalMs,
          ...(options.env ? { env: options.env } : {}),
        });

    // Boundary: a cycle finished and the gate still fails. The next cycle is a
    // fresh session, so stopping here costs nothing a normal transition doesn't.
    if (!verify.ok && parkRequested()) return failure('parked', verify);
  }

  return { ok: true, verify };
}
