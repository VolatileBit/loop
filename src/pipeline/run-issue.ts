/**
 * The resume-aware per-issue pipeline: implement → verifyFix → review →
 * reviewFix, restructured around an entry cursor (see the plan's "Resumable
 * stage checkpoints"). The caller resolves the entry stage (via
 * issues/resolve-resume-stage.ts) *before* claiming the issue and passes it
 * in; each stage writes the `lastStage` checkpoint as it begins.
 *
 * Entry semantics:
 * - `implement`  — full pipeline (today's behavior).
 * - `verifyFix`  — skip the implement session; run verify fresh and enter the
 *                  verify-fix loop with a full cycle budget.
 * - `review`     — safety-check verify once; on unexpected failure fall back
 *                  to the verifyFix entry instead of reviewing a broken tree.
 * - `reviewFix`  — rebuild the fix prompt from the pending review feedback in
 *                  the handoff file; if none exists, degrade to the `review`
 *                  entry (safety verify + fresh review).
 *
 * All failure paths return a structured result (with `fatal` describing the
 * would-be failStop) instead of exiting, so parallel workers can survive one
 * issue's failure. Triage transitions are role-based; all cwd/run-context is
 * per-worker.
 */

import path from 'node:path';

import { afterAgentStage } from '../agent/after-stage.js';
import { describeAgentFailure, type AgentRunResult } from '../agent/run-agent.js';
import { agentStageUsageEntries } from '../agent/usage.js';
import type { UsageLimitDetails } from '../agent/providers/usage-limit.js';
import type { StageCliFlags } from '../config/stage-settings.js';
import { resolveStageAgentSettings } from '../config/stage-settings.js';
import { resolveProjectAllowDeclaredVerify, resolveProjectEnv } from '../config/project-settings.js';
import type { TriageLabels, TriageRole } from '../config/triage-labels.js';
import type { LoopConfig, PipelineStageName, StageName } from '../config/types.js';
import { logLoopCommit } from '../git/log-commit.js';
import { listDirtyPaths } from '../git/status.js';
import {
  archiveAndClearHandoff,
  readHandoff,
  readPendingReviewFeedback,
  recordHandoffFallbackCommit,
} from '../handoff/handoff.js';
import { ensureProjectNotes } from '../handoff/project-notes.js';
import { isParkRequested, isShuttingDown } from '../interrupt/shutdown.js';
import { discoverIssues } from '../issues/discovery.js';
import {
  escalateIssueForHuman,
  escalateIssueUnverifiable,
  printHumanInterventionRequired,
} from '../issues/escalation.js';
import {
  isLoopComplete,
  isSelfReportedComplete,
  issueTriageRole,
  markInProgress,
  setIssueTriage,
} from '../issues/lifecycle.js';
import { clearIssueStage, setIssueStage } from '../issues/resolve-resume-stage.js';
import { resolveIssueSpec } from '../issues/resolve-spec.js';
import type { IssueRecord } from '../issues/types.js';
import { formatOutputPrefix } from '../logs/output-prefix.js';
import { createRunContext, type RunContext } from '../logs/run-context.js';
import { recordRun, type RunRecord } from '../logs/run-record.js';
import { caution } from '../logs/style.js';
import { describeConvergenceFailure } from '../review/convergence.js';
import { buildImplementPrompt, type PromptContext } from '../review/prompts.js';
import { executeReviewFixLoop } from '../review/review-fix-loop.js';
import { warnIfReviewDiffLimited } from '../review/run-review-session.js';
import {
  printVerifyFailureSummary,
  recordSkippedVerify,
  verifySatisfiedInSession,
  type ShellVerifyResult,
} from '../verify/run-verify.js';
import {
  announceDeclaredVerifyCmd,
  ensureDeclaredVerifyDir,
  declaredVerifyPath,
  resolveDeclaredVerifyCmd,
} from '../verify/declared-verify.js';
import { executeVerifyFixLoop } from '../verify/verify-fix-loop.js';
import type { StageUsage } from '../usage/tokens.js';
import { resolvePipelineDeps, type PipelineDeps } from './deps.js';

export type PipelineFatal = {
  reason: string;
  code?: number;
  details?: string[];
};

export type IssuePipelineResult = {
  outcome: string;
  issueDone: boolean;
  usageLimited: boolean;
  /** Set iff usageLimited — which limit window was hit and when it lifts (best-effort). */
  usageLimitDetails: UsageLimitDetails | null;
  /** The triage role the pipeline left the issue in. */
  finalRole: TriageRole;
  /** The `lastStage` checkpoint after this run (null when cleared, i.e. done). */
  lastStage: PipelineStageName | null;
  /** On usage-limit outcomes: the dead session's id, when the CLI reported one — feeds a resume after the wait. */
  limitSessionId: string | null;
  runDir: string;
  usageEntries: StageUsage[];
  /** Set on every failure — the serial runner failStops with it; parallel workers log and continue. */
  fatal: PipelineFatal | null;
};

/**
 * Goal-mode pipeline context: the verify contract inverts — the implement
 * session declares the command, loop executes exactly what was declared (the
 * file is re-read before every run so fix sessions can correct it), and no
 * declaration escalates the issue as unverifiable.
 */
export type GoalPipelineContext = {
  goalDocPath: string;
  declareVerifyPath: string;
  verifyNotesPath: string;
  readDeclaredVerifyCmd: () => string | null;
};

export type IssuePipelineOptions = {
  /** Where to enter the pipeline — resolve via resolveResumeStage() *before* claiming the issue. */
  entryStage: PipelineStageName;
  iteration: number;
  /** Main repo root — `.loop/` bookkeeping (runs, handoffs, state). */
  root: string;
  /** Work root — rolling worktree or a per-issue worktree. */
  cwd: string;
  config: LoopConfig;
  cliFlags?: StageCliFlags;
  labels: TriageLabels;
  /** Resolved verify command (callers fail fast before here when unset). Ignored in goal mode — the declared command gates instead. */
  verifyCmd: string;
  /** Present in goal mode (see GoalPipelineContext). */
  goal?: GoalPipelineContext;
  /**
   * Post-limit-wait resume hint: the checkpointed stage re-enters by resuming
   * this session (same cwd required — claude scopes sessions per directory)
   * instead of starting fresh. Ignored when the entry stage doesn't match.
   */
  resumeSession?: { stage: PipelineStageName; sessionId: string } | null;
  liveOutput?: boolean;
  /** Observe stage transitions (worker status display). */
  onStage?: (stage: StageName, label: string) => void;
  /** Observe the run context as soon as it exists (force-stop interrupted-run bookkeeping). */
  onRunContext?: (ctx: RunContext) => void;
  /** Test seam: overrides the process-wide "stop at the next stage boundary" check. */
  parkRequested?: () => boolean;
  deps?: Partial<PipelineDeps>;
};

export async function runIssuePipeline(
  issue: IssueRecord,
  options: IssuePipelineOptions,
): Promise<IssuePipelineResult> {
  const deps = resolvePipelineDeps(options.deps);
  const { config, labels, root, cwd, goal } = options;
  const parkRequested = options.parkRequested ?? isParkRequested;
  // Resolved once: every session and every verify run for this issue must see
  // the same environment, or in-session verify evidence would not transfer.
  const env = resolveProjectEnv(config, issue.project);

  // Project mode's declared-verify contract. Re-read per call (never cached),
  // so the evidence-based skip always compares against the *current* command: a
  // session that proved the old one and then replaced it fails the evidence
  // test and gets a real run.
  const declaredVerifyAllowed = !goal && resolveProjectAllowDeclaredVerify(config, issue.project);
  const announcedDeclarations = new Set<string>();
  const resolveProjectVerify = (): string => {
    const resolution = resolveDeclaredVerifyCmd({
      root,
      project: issue.project,
      issueId: issue.id,
      configuredCmd: options.verifyCmd,
      allowed: declaredVerifyAllowed,
    });
    announceDeclaredVerifyCmd(
      formatOutputPrefix('loop', `${issue.qualifiedId}-verify`),
      resolution,
      options.verifyCmd,
      announcedDeclarations,
    );
    // Keep the prompt context current: a session may declare mid-issue, and the
    // review has to see the command that actually gated the work.
    if (promptContext.declaredVerify) {
      promptContext.declaredVerify.declaredCmd = resolution.declared ? resolution.cmd : null;
    }
    return resolution.cmd;
  };
  // Reassigned to the declared command in goal mode (see the goal gate below);
  // the `record` closure reads the binding at call time, so records made after
  // resolution carry the command that actually gated the work.
  let verifyCmd = options.verifyCmd;
  const cliFlags = options.cliFlags ?? {};
  const liveOutput = options.liveOutput ?? true;
  const entry = options.entryStage;
  let model = resolveStageAgentSettings(config, cliFlags, 'implement', issue.project).model;
  // Dirty paths are preserved so a fallback commit never absorbs someone
  // else's work in progress. That holds on a fresh start; on a *resume* it
  // inverts, because the dirty tree is the previous run's own unfinished
  // output. Preserving it there means the work can never be committed: each
  // restart re-captures it as "pre-existing", review keeps judging a HEAD that
  // lacks it, and the finding recurs forever. A prior run lost five review rounds
  // to exactly that, on lab files an agent could not commit itself because its
  // sandbox denies `git index.lock`.
  const preExistingDirtyPaths = entry === 'implement' ? listDirtyPaths(cwd) : [];

  const promptContext: PromptContext = {
    reviewSkill: config.reviewSkill,
    tddSkill: config.tddSkill,
    specRelPath: goal ? null : resolveIssueSpec(issue, config, cwd, root),
    labels: { inProgress: labels.inProgress, done: labels.done },
    // In goal mode there is no pre-known command — the session declares one
    // (the goal block below states the deal for the declared command instead).
    verifyCmd: goal ? null : verifyCmd,
    projectNotesPath: ensureProjectNotes(root, issue.project),
    ...(goal
      ? {
          goal: {
            goalDocPath: goal.goalDocPath,
            declareVerifyPath: goal.declareVerifyPath,
            verifyNotesPath: goal.verifyNotesPath,
          },
        }
      : {}),
    ...(declaredVerifyAllowed
      ? {
          declaredVerify: {
            // Created up front so the session writes into a directory that
            // exists, and outside the worktree so writing it cannot retract
            // the session's own in-session verify evidence.
            declarePath: path.join(
              ensureDeclaredVerifyDir(root, issue.project),
              path.basename(declaredVerifyPath(root, issue.project, issue.id)),
            ),
            configuredCmd: options.verifyCmd,
            declaredCmd: verifyCmd === options.verifyCmd ? null : verifyCmd,
          },
        }
      : {}),
  };

  if (declaredVerifyAllowed) verifyCmd = resolveProjectVerify();

  markInProgress(issue, labels);

  const onStage = (stage: PipelineStageName, label: string): void => {
    setIssueStage(issue, stage);
    options.onStage?.(stage, label);
  };

  const prompt =
    entry === 'implement'
      ? buildImplementPrompt(issue, { handoff: readHandoff(root, issue) }, promptContext)
      : `[loop] resumed at ${entry} — no implement prompt for this run`;

  const run: RunContext = createRunContext(
    issue,
    options.iteration,
    prompt,
    root,
    cwd,
    preExistingDirtyPaths,
  );
  options.onRunContext?.(run);
  console.log(`Run dir: ${path.relative(root, run.runDir)}/`);
  if (entry !== 'implement') {
    console.log(`[loop] resuming ${issue.qualifiedId} at stage "${entry}" (lastStage checkpoint).`);
  }

  /** Retry telemetry for the run record; empty when the failure had nothing to do with the provider. */
  const infraFailureRecord = (
    agentResult: Pick<AgentRunResult, 'infraSignature' | 'infraRetries'>,
  ): Pick<RunRecord, 'infraRetries' | 'infraSignature'> =>
    agentResult.infraSignature
      ? {
          infraRetries: agentResult.infraRetries?.retries ?? 0,
          infraSignature: agentResult.infraSignature,
        }
      : {};

  let finalRole: TriageRole = 'inProgress';
  const setTriage = (role: TriageRole): void => {
    setIssueTriage(issue, role, labels);
    finalRole = role;
  };

  const record = (partial: Partial<RunRecord> & { outcome: string }): void => {
    recordRun(run, root, { model, verifyCmd, ...partial });
  };

  const result = (outcome: string, extras: Partial<IssuePipelineResult> = {}): IssuePipelineResult => ({
    outcome,
    issueDone: false,
    usageLimited: false,
    usageLimitDetails: null,
    finalRole,
    lastStage: issue.lastStage ?? null,
    limitSessionId: null,
    runDir: run.runDir,
    usageEntries: run.usageEntries,
    fatal: null,
    ...extras,
  });

  /**
   * Park the issue at a stage boundary after a second ESC. Deliberately not a
   * failure: the issue keeps a runnable role and a checkpoint, so the next
   * `loop run` picks it up exactly here. The `parked` outcome is what tells the
   * caller to end the run cleanly rather than print a failure banner.
   */
  const parkAt = (resumeStage: PipelineStageName, afterStage: string): IssuePipelineResult => {
    setIssueStage(issue, resumeStage);
    setTriage('agentInterrupted');
    record({ outcome: 'parked', agentOk, verifyOk: null, stuckReason: 'parked' });
    console.log(
      caution(
        `[loop] parked ${issue.qualifiedId} after ${afterStage} — resumes at ${resumeStage} on the next \`loop run\`.`,
      ),
    );
    return result('parked', { lastStage: resumeStage });
  };

  const resumeFor = (stage: PipelineStageName): { sessionId: string } | null =>
    options.resumeSession?.stage === stage ? { sessionId: options.resumeSession.sessionId } : null;

  const rediscover = (fallback: IssueRecord): IssueRecord =>
    discoverIssues(config.issuesDir, cwd).find((item) => item.qualifiedId === issue.qualifiedId) ?? fallback;

  // --- implement stage ---------------------------------------------------

  let refreshed = issue;
  let agentOk = true;
  /** Verify commands the implement session proved in-stream ([] on resume entries — that work ran in a prior attempt). */
  let implementEvidence: string[] = [];

  if (entry === 'implement') {
    onStage('implement', 'implement');
    const agentResult = await deps.runAgent(prompt, {
      config,
      cliFlags,
      stage: 'implement',
      project: issue.project,
      cwd,
      logPath: run.agentLogPath,
      stageLabel: `${issue.qualifiedId}-implement`,
      liveOutput,
      env,
      ...(resumeFor('implement') ? { resume: resumeFor('implement') } : {}),
    });
    run.usageEntries.push(...agentStageUsageEntries('implement', agentResult));
    model = agentResult.model;
    agentOk = agentResult.ok;

    if (isShuttingDown() || agentResult.stuckReason === 'interrupted') {
      setTriage('agentInterrupted');
      record({ outcome: 'interrupted', agentOk: false, verifyOk: null, stuckReason: 'interrupted' });
      return result('interrupted', {
        fatal: {
          reason: `implement session for ${issue.qualifiedId} was interrupted`,
          code: 130,
          details: [`Run dir: ${path.relative(root, run.runDir)}/`],
        },
      });
    }

    refreshed = rediscover(issue);

    if (agentResult.usageLimited) {
      setTriage('agentFailed');
      record({ outcome: 'usage-limit', agentOk: false, verifyOk: null, usageLimited: true });
      return result('usage-limit', {
        usageLimited: true,
        usageLimitDetails: agentResult.usageLimitDetails,
        limitSessionId: agentResult.sessionId ?? null,
        fatal: {
          reason: `usage limit hit during implement session for ${issue.qualifiedId}`,
          code: 2,
          details: [`Run dir: ${path.relative(root, run.runDir)}/`],
        },
      });
    }

    if (agentResult.stuckReason) {
      setTriage('agentFailed');
      record({ outcome: agentResult.stuckReason, agentOk: false, verifyOk: null, stuckReason: agentResult.stuckReason });
      return result(agentResult.stuckReason, {
        fatal: {
          reason: `implement session for ${issue.qualifiedId} got stuck (${agentResult.stuckReason})`,
          details: [`Agent log: ${path.relative(root, run.agentLogPath)}`],
        },
      });
    }

    if (!agentResult.ok) {
      setTriage('agentFailed');
      record({
        outcome: 'agent-failed',
        agentOk: false,
        verifyOk: null,
        ...infraFailureRecord(agentResult),
      });
      return result('agent-failed', {
        fatal: {
          reason: `implement session for ${issue.qualifiedId} ${describeAgentFailure(agentResult)}`,
          details: [`Agent log: ${path.relative(root, run.agentLogPath)}`],
        },
      });
    }

    const suggestion = afterAgentStage(agentResult, root, issue);
    const implementCommit = logLoopCommit(run, refreshed.qualifiedId, 'implement', {
      cwd,
      excludePaths: config.commitExcludePaths,
      suggestion,
    });
    recordHandoffFallbackCommit(root, issue, implementCommit);
    implementEvidence = agentResult.provenCommands;

    // Boundary: implement is done and committed. Checkpoint at verifyFix so a
    // resume proceeds to the gate instead of re-running the implementation.
    if (parkRequested()) return parkAt('verifyFix', 'implement');
  }

  // --- goal gate: resolve the declared verify command ----------------------
  // Runs for every entry (resume paths re-read too — a human or fix session
  // may have corrected the declaration since the last attempt).

  if (goal) {
    const declared = goal.readDeclaredVerifyCmd();
    if (!declared) {
      // Checkpoint at verifyFix: the work exists; once a human declares the
      // command and unblocks, the retry re-enters here and proceeds to verify.
      setIssueStage(issue, 'verifyFix');
      const unverifiableIssue = rediscover(refreshed);
      escalateIssueUnverifiable(unverifiableIssue, {
        declareVerifyPath: goal.declareVerifyPath,
        labels,
      });
      finalRole = 'readyForHuman';
      issue.triage = unverifiableIssue.triage;
      console.error(
        `[loop] ${issue.qualifiedId} declared no verify command — escalated as unverifiable (expected at ${goal.declareVerifyPath}).`,
      );
      record({ outcome: 'unverifiable', agentOk, verifyOk: null });
      return result('unverifiable', {
        fatal: {
          reason: `${issue.qualifiedId} is unverifiable — no verify command was declared`,
          details: [`Expected declaration: ${goal.declareVerifyPath}`],
        },
      });
    }
    verifyCmd = declared;
  }

  // --- verify phase (with resume-at-review safety fallback) ---------------

  let verify: ShellVerifyResult | null = null;
  let resumeAtFix: { feedback: string } | null = null;
  let cursor: 'verify' | 'review' | 'reviewFix';
  let initialVerify: ShellVerifyResult | null = null;

  if (entry === 'implement' || entry === 'verifyFix') {
    cursor = 'verify';
  } else {
    let effectiveEntry: 'review' | 'reviewFix' = entry;
    if (entry === 'reviewFix') {
      const pending = readPendingReviewFeedback(root, issue);
      if (pending) {
        resumeAtFix = { feedback: pending };
      } else {
        console.warn(
          `[loop] no pending review feedback recorded for ${issue.qualifiedId} — falling back to a fresh review.`,
        );
        effectiveEntry = 'review';
      }
    }

    if (resumeAtFix) {
      cursor = 'reviewFix';
    } else if (effectiveEntry === 'review') {
      // Safety check, not an assumption: re-verify once before reviewing.
      if (declaredVerifyAllowed) verifyCmd = resolveProjectVerify();
      const safety = await deps.runVerifyCommand(verifyCmd, cwd, run.verifyLogPath, {
        stageLabel: `${issue.qualifiedId}-verify`,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        env,
      });
      if (safety.ok) {
        verify = safety;
        cursor = 'review';
      } else {
        console.warn(
          `[loop] resume-at-review safety verify failed for ${issue.qualifiedId} — the tree changed since the last attempt; entering at verifyFix instead.`,
        );
        initialVerify = safety;
        cursor = 'verify';
      }
    } else {
      cursor = 'reviewFix';
    }
  }

  if (cursor === 'verify') {
    onStage('verifyFix', 'verify');
    // Re-resolve: the implement session may have just declared a replacement,
    // and that is precisely the case this feature exists for. Capturing the
    // command before the session ran would defer every declaration by a cycle.
    if (declaredVerifyAllowed) verifyCmd = resolveProjectVerify();
    // The implement session's stream may already have proven the gate; the
    // resume-at-review fallback (`initialVerify`) is a real failed run and is
    // never skipped.
    const first =
      initialVerify ??
      (verifySatisfiedInSession(implementEvidence, verifyCmd)
        ? recordSkippedVerify(verifyCmd, run.verifyLogPath)
        : await deps.runVerifyCommand(verifyCmd, cwd, run.verifyLogPath, {
            stageLabel: `${issue.qualifiedId}-verify`,
            heartbeatIntervalMs: config.heartbeatIntervalMs,
            env,
          }));
    const verifyLoop = await executeVerifyFixLoop(refreshed, first, {
      config,
      cliFlags,
      verifyCmd,
      root,
      cwd,
      runDir: run.runDir,
      commitCtx: run,
      liveOutput,
      onStage,
      promptContext,
      parkRequested,
      env,
      ...(goal
        ? { resolveVerifyCmd: goal.readDeclaredVerifyCmd }
        : declaredVerifyAllowed
          ? { resolveVerifyCmd: resolveProjectVerify }
          : {}),
      ...(resumeFor('verifyFix') ? { resumeFirstSession: resumeFor('verifyFix') } : {}),
      deps,
    });

    if (!verifyLoop.ok) {
      const failedVerify = verifyLoop.verify ?? first;

      if (verifyLoop.outcome === 'usage-limit') {
        setTriage('agentFailed');
        record({ outcome: 'usage-limit', agentOk, verifyOk: false, usageLimited: true });
        return result('usage-limit', {
          usageLimited: true,
          usageLimitDetails: verifyLoop.usageLimitDetails ?? null,
          limitSessionId: verifyLoop.usageLimitSessionId ?? null,
          fatal: {
            reason: `usage limit hit during verify fix loop for ${issue.qualifiedId}`,
            code: 2,
            details: [`Run dir: ${path.relative(root, run.runDir)}/`],
          },
        });
      }

      if (verifyLoop.outcome === 'parked') {
        return parkAt('verifyFix', 'a verify-fix cycle');
      }

      if (verifyLoop.outcome === 'interrupted') {
        setTriage('agentInterrupted');
        record({ outcome: 'interrupted', agentOk: false, verifyOk: false, stuckReason: 'interrupted' });
        return result('interrupted', {
          fatal: {
            reason: `verify fix loop for ${issue.qualifiedId} was interrupted`,
            code: 130,
            details: [`Run dir: ${path.relative(root, run.runDir)}/`],
          },
        });
      }

      if (verifyLoop.outcome === 'verify-failed') {
        setTriage('verifyFailed');
        record({ outcome: 'verify-failed', agentOk, verifyOk: false });
        printVerifyFailureSummary(failedVerify, config.maxVerifyCycles);
        return result('verify-failed', {
          fatal: {
            reason: `verify still failing for ${issue.qualifiedId} after ${config.maxVerifyCycles} fix attempt(s)`,
            details: [`Verify log: ${path.relative(root, run.verifyLogPath)}`],
          },
        });
      }

      setTriage('agentFailed');
      record({ outcome: verifyLoop.outcome, agentOk, verifyOk: false, stuckReason: verifyLoop.outcome });
      return result(verifyLoop.outcome, {
        fatal: {
          reason: `verify fix loop stopped for ${issue.qualifiedId}`,
          details: [`Outcome: ${verifyLoop.outcome}`, `Run dir: ${path.relative(root, run.runDir)}/`],
        },
      });
    }

    verify = verifyLoop.verify;
  }

  // --- completion gate (only meaningful when a verify result exists) ------

  const issueAfterVerify = rediscover(refreshed);

  if (verify) {
    const selfReported = isSelfReportedComplete(issueAfterVerify, labels);
    const agentSetDone = issueTriageRole(issueAfterVerify, labels) === 'done';
    const loopConfirmed = verify.ok && isLoopComplete(issueAfterVerify, verify.ok, labels);

    console.log(`Verify (${verifyCmd}): ${verify.ok ? 'ok' : 'failed'}`);
    console.log(`Agent self-reported complete: ${selfReported ? 'yes' : 'no'}`);
    console.log(`Issue triage after agent: ${issueAfterVerify.triage}`);
    console.log(`Loop confirmed complete: ${loopConfirmed ? 'yes' : 'no'}`);
    if (agentSetDone && !verify.ok) {
      console.warn(
        `[loop] agent set triage: ${labels.done} before verify passed — triage will be reset to ${labels.verifyFailed}.`,
      );
    }

    if (!isLoopComplete(issueAfterVerify, verify.ok, labels)) {
      // The gate passed, so whatever is outstanding is unwritten work, not a
      // failing test. Resuming at `verifyFix` would re-run a green gate and
      // stop here again, forever — send the next run back to `implement`, and
      // name the unchecked criteria so it need not re-derive them from a
      // context that has very likely been compacted since they were read.
      const unchecked = issueAfterVerify.acceptanceCriteria
        .filter((line) => !/^- \[x\]/i.test(line))
        .map((line) => line.replace(/^- \[ \]\s*/, ''));
      setIssueStage(issueAfterVerify, 'implement');
      record({ outcome: 'issue-not-marked-done', agentOk, verifyOk: verify.ok });
      return result('issue-not-marked-done', {
        lastStage: 'implement',
        fatal: {
          reason: `${issueAfterVerify.qualifiedId} not marked done despite passing verify`,
          details: [
            `Acceptance criteria are unchecked and triage is not ${labels.done}.`,
            `Issue file: ${issueAfterVerify.relPath}`,
            ...unchecked.map((criterion) => `Unchecked: ${criterion}`),
            'Checkpoint reset to "implement" so the next run finishes the work rather than re-verifying.',
          ],
        },
      });
    }
  }

  // --- review ↔ review-fix loop -------------------------------------------

  warnIfReviewDiffLimited(cwd);
  const reviewLoop = await executeReviewFixLoop(issueAfterVerify, {
    config,
    cliFlags,
    verifyCmd,
    root,
    cwd,
    run,
    liveOutput,
    onStage,
    promptContext,
    parkRequested,
    env,
    resumeAtFix,
    ...(goal
      ? { resolveVerifyCmd: goal.readDeclaredVerifyCmd }
      : declaredVerifyAllowed
        ? { resolveVerifyCmd: resolveProjectVerify }
        : {}),
    ...(resumeFor('review') ? { resumeReviewSession: resumeFor('review') } : {}),
    ...(resumeFor('reviewFix') ? { resumeFixSession: resumeFor('reviewFix') } : {}),
    deps,
  });

  const baseRecord = {
    agentOk,
    verifyOk: verify?.ok ?? null,
  };

  if (!reviewLoop.ok) {
    const reviewArtifacts = path.join(run.runDir, 'reviews');
    // Pin the checkpoint to the precise failing stage (e.g. needs-human is a
    // reviewFix checkpoint even though the *last begun* stage was a review).
    setIssueStage(issue, reviewLoop.stageAtFailure);

    if (reviewLoop.outcome === 'parked') {
      return parkAt(reviewLoop.stageAtFailure, 'a review round');
    }

    if (reviewLoop.outcome === 'needs-human' && reviewLoop.verdict) {
      escalateIssueForHuman(issueAfterVerify, reviewLoop.verdict, {
        artifactDir: reviewArtifacts,
        maxCycles: config.maxReviewCycles,
        labels,
        root,
        ...(reviewLoop.convergence ? { convergence: reviewLoop.convergence } : {}),
      });
      finalRole = 'readyForHuman';
      logLoopCommit(run, issueAfterVerify.qualifiedId, 'escalate', {
        cwd,
        excludePaths: config.commitExcludePaths,
      });
      printHumanInterventionRequired(issueAfterVerify, reviewLoop.verdict, {
        artifactDir: reviewArtifacts,
        labels,
        root,
        ...(reviewLoop.convergence ? { convergence: reviewLoop.convergence } : {}),
      });
      record({
        ...baseRecord,
        outcome: 'needs-human',
        reviewChangesRequested: true,
        reviewSeverity: reviewLoop.verdict.severity,
      });
      return result('needs-human', {
        fatal: {
          reason: `${issueAfterVerify.qualifiedId} escalated for human review`,
          details: [
            `Reason: ${describeConvergenceFailure(
              reviewLoop.convergence ?? {
                reviewCount: 0,
                recurringFamilies: [],
                latestFamilies: [],
                reviewsWithoutFamilies: 0,
              },
              config.maxReviewCycles,
            )}.`,
            `See ${path.relative(root, reviewArtifacts)}/`,
          ],
        },
      });
    }

    if (reviewLoop.outcome === 'usage-limit') {
      setTriage('agentFailed');
    } else if (reviewLoop.outcome === 'interrupted') {
      setTriage('agentInterrupted');
    } else if (reviewLoop.outcome === 'verify-failed') {
      setTriage('verifyFailed');
      if (reviewLoop.verify) {
        printVerifyFailureSummary(reviewLoop.verify, config.maxVerifyCycles);
      }
    } else {
      setTriage('agentFailed');
    }

    record({
      ...baseRecord,
      outcome: reviewLoop.outcome,
      usageLimited: reviewLoop.outcome === 'usage-limit',
      reviewChangesRequested: reviewLoop.verdict?.changesRequested ?? true,
      reviewSeverity: reviewLoop.verdict?.severity ?? 'blocking',
    });
    return result(reviewLoop.outcome, {
      usageLimited: reviewLoop.outcome === 'usage-limit',
      usageLimitDetails: reviewLoop.outcome === 'usage-limit' ? (reviewLoop.usageLimitDetails ?? null) : null,
      limitSessionId: reviewLoop.outcome === 'usage-limit' ? (reviewLoop.usageLimitSessionId ?? null) : null,
      fatal: {
        reason: `review loop stopped for ${issueAfterVerify.qualifiedId}`,
        ...(reviewLoop.outcome === 'usage-limit' ? { code: 2 } : {}),
        ...(reviewLoop.outcome === 'interrupted' ? { code: 130 } : {}),
        details:
          reviewLoop.outcome === 'fix-coverage-missing'
            ? [
                `Missing or incomplete Loop fix coverage for: ${(reviewLoop.missingCoverageFamilies ?? [])
                  .map((id) => `\`${id}\``)
                  .join(', ')}`,
                `See ${path.relative(
                  root,
                  reviewLoop.coverageArtifactPath ?? reviewArtifacts,
                )}`,
              ]
            : [`Outcome: ${reviewLoop.outcome}`, `See ${path.relative(root, reviewArtifacts)}/`],
      },
    });
  }

  console.log(`[loop] review satisfied: ${reviewLoop.verdict.summary}`);

  // --- completion ----------------------------------------------------------

  const completedIssue = rediscover(issueAfterVerify);
  if (issueTriageRole(completedIssue, labels) !== 'done') {
    // Also clears the lastStage checkpoint (see issues/lifecycle.ts).
    setIssueTriage(completedIssue, 'done', labels);
  } else {
    clearIssueStage(completedIssue);
  }
  finalRole = 'done';
  issue.triage = completedIssue.triage;
  delete issue.lastStage;

  logLoopCommit(run, completedIssue.qualifiedId, 'complete', {
    cwd,
    excludePaths: config.commitExcludePaths,
  });
  archiveAndClearHandoff(root, issue, path.join(run.runDir, 'handoff.md'));

  record({
    ...baseRecord,
    outcome: 'completed',
    issueDone: true,
    reviewChangesRequested: reviewLoop.verdict.changesRequested,
    reviewSeverity: reviewLoop.verdict.severity,
  });

  return result('completed', { issueDone: true, lastStage: null });
}
