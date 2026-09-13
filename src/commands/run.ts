/**
 * `loop run [project]` — the autonomous issue loop. Serial (maxParallelRuns
 * === 1) preserves today's behavior: one issue at a time in the rolling
 * worktree with the full live stream, stopping the whole run on any failure.
 * Parallel (> 1) drives runWorkerPool with per-issue worktrees that merge
 * back into the rolling branch on any outcome that produced commits; the
 * live stream is replaced by a periodic compact worker-status block, and a
 * failed issue is recorded (triage + escalation) without stopping the run.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import type { UsageLimitDetails } from '../agent/providers/usage-limit.js';
import {
  resolveProjectEnv,
  resolveProjectUsageLimitPolicy,
  resolveProjectVerifyCmd,
} from '../config/project-settings.js';
import { resolveStageAgentCandidates, type StageCliFlags } from '../config/stage-settings.js';
import { TRIAGE_ROLES, type TriageLabels } from '../config/triage-labels.js';
import { badge, stage as styleStage } from '../logs/style.js';
import { STAGE_NAMES, type AgentCli, type LoopConfig, type PipelineStageName, type UsageLimitPolicy } from '../config/types.js';
import { getHeadSha } from '../git/status.js';
import { readHandoff } from '../handoff/handoff.js';
import { projectNotesPath } from '../handoff/project-notes.js';
import { failStop, registerShutdownHandlers } from '../interrupt/shutdown.js';
import { discoverIssues } from '../issues/discovery.js';
import { escalateIssueForMergeConflict, escalateIssueForSemanticConflict } from '../issues/escalation.js';
import {
  isDone,
  issueTriageRole,
  issuesWithUnknownTriage,
  isSettled,
  markInProgress,
  setIssueTriage,
} from '../issues/lifecycle.js';
import { resolveIssueSpec } from '../issues/resolve-spec.js';
import { clearIssueStage, resolveResumeStage, setIssueStage } from '../issues/resolve-resume-stage.js';
import {
  buildBlockerIndex,
  pickNextIssue,
  reportDanglingBlockers,
  resolveBlocker,
} from '../issues/scheduling.js';
import { resolveProjectFilter } from '../issues/project.js';
import type { IssueRecord } from '../issues/types.js';
import { unblockNeedsHumanIssues } from '../issues/unblock.js';
import type { RunContext } from '../logs/run-context.js';
import { recordInterruptedRun } from '../logs/run-record.js';
import { loadState, saveState, type LoopState } from '../logs/state.js';
import { formatWorkerStatusBlock, type WorkerStatusEntry } from '../logs/worker-status.js';
import { createNotifier, usageLimitEvent, type Notifier } from '../notify/webhooks.js';
import { runIssuePipeline, type IssuePipelineResult } from '../pipeline/run-issue.js';
import { buildImplementPrompt, type PromptContext } from '../review/prompts.js';
import { warnIfReviewDiffLimited } from '../review/run-review-session.js';
import { acquireInvocationLock } from '../shared/lock.js';
import { shell } from '../shared/shell.js';
import { mergeLimitWait, waitForLimitReset, REAL_CLOCK, type LimitWait } from '../usage/limit-wait.js';
import { formatUsageTable, totalKnownCostUsd, type StageUsage } from '../usage/tokens.js';
import {
  describePreflightFailure,
  printPreflightFailure,
  runPreflight,
  type PreflightResult,
} from '../verify/preflight.js';
import { runVerifyCommand } from '../verify/run-verify.js';
import {
  cleanupIssueWorktree,
  createIssueWorktree,
  listLeftoverIssueWorktrees,
  mergeIssueWorktree,
} from '../worktree/issue-worktree.js';
import { getCurrentBranchName } from '../worktree/rolling-worktree.js';
import { runWorkerPool } from '../worktree/worker-pool.js';
import type { RunFlags } from '../cli/args.js';
import { startupCommand, type CommandStartup } from './startup.js';

const WORKER_STATUS_INTERVAL_MS = 5000;

function printUsageTotals(allUsage: StageUsage[]): void {
  if (allUsage.length === 0) return;
  console.log(`\n[loop] token usage totals for this run:\n${formatUsageTable(allUsage)}`);
}

/**
 * Per-issue failures the parallel pool safely claims past: the issue is parked
 * (needs-human) or checkpointed for a later retry (verify-failed), the
 * `claimed` set prevents an in-run re-claim, and one stuck issue must not
 * strand an unattended run's remaining budget. Every other failure (agent
 * crash, timeouts, incomplete) usually points at something environmental —
 * broken dev DB, expired auth — where marching on burns budget for nothing,
 * so the pool drains in-flight work and stops claiming.
 */
const ESCALATION_OUTCOMES: ReadonlySet<string> = new Set(['needs-human', 'verify-failed']);

function warnIfBudgetCannotSeeAllCost(
  config: LoopConfig,
  cliFlags: StageCliFlags,
  budgetUsd: number | null,
): void {
  if (budgetUsd === null) return;
  const blind = new Set<AgentCli>();
  for (const stage of STAGE_NAMES) {
    for (const settings of resolveStageAgentCandidates(config, cliFlags, stage)) {
      if (settings.agentCli !== 'claude-code') blind.add(settings.agentCli);
    }
  }
  if (blind.size > 0) {
    console.warn(
      `[loop] warning: --budget only counts cost the agent CLI reports; ${[...blind].join(', ')} ` +
        'sessions report none, so their spend is invisible to the cap.',
    );
  }
}

/** The policy for the issue that hit the limit — its project override wins over the global map. */
function limitPolicyFor(config: LoopConfig, project: string, details: UsageLimitDetails | null): UsageLimitPolicy {
  return resolveProjectUsageLimitPolicy(config, project, details?.scope ?? 'session');
}

/**
 * An unrecognized `triage:` label makes an issue silently unrunnable, so a typo
 * removes it from the backlog with nothing said. Report rather than repair:
 * loop cannot know which role was meant.
 */
function reportUnknownTriage(issues: IssueRecord[], labels: TriageLabels): void {
  const unknown = issuesWithUnknownTriage(issues, labels);
  if (unknown.length === 0) return;
  console.warn(
    `[loop] ${unknown.length} issue(s) carry a triage label in no configured vocabulary and will never be claimed:`,
  );
  for (const issue of unknown) console.warn(`  - ${issue.qualifiedId} (triage: ${issue.triage})`);
  console.warn(`  Valid labels: ${TRIAGE_ROLES.map((role) => labels[role]).join(', ')}`);
}

/** Issues a person owns right now — reported alongside every run outcome. */
function countDelegated(issues: IssueRecord[], labels: TriageLabels): number {
  return issues.filter((issue) => issueTriageRole(issue, labels) === 'delegatedToHuman').length;
}

function printNoRunnableIssues(
  issues: IssueRecord[],
  startup: CommandStartup,
  project: string | null,
): 'all-complete' | 'blocked' {
  const inProject = project
    ? issues.filter((issue) => issue.project.toLowerCase() === project.toLowerCase())
    : issues;
  // "Complete" is about whether loop is waiting on anyone, not about `done`:
  // a backlog whose remainder a person has taken on is finished, not blocked.
  const remaining = inProject.filter((issue) => !isSettled(issue, startup.labels));
  const delegated = inProject.filter(
    (issue) => issueTriageRole(issue, startup.labels) === 'delegatedToHuman',
  );
  const projectNote = project ? ` in project "${project}"` : '';

  if (delegated.length > 0) {
    // Announced, never silently passed over — "backlog complete" must not stand
    // in for "complete, except your part".
    console.log(
      `${delegated.length} issue(s)${projectNote} are owned by a human (${startup.labels.delegatedToHuman}):`,
    );
    for (const issue of delegated) console.log(`  - ${issue.qualifiedId} — ${issue.title}`);
  }

  if (remaining.length === 0) {
    console.log(`All issues${projectNote} complete.`);
    return 'all-complete';
  }
  console.log(`No runnable issues${projectNote}. Remaining issues${projectNote} are blocked or not ready:`);
  // Blockers are resolved against every discovered issue, not just the
  // in-project ones, so a cross-project reference is not reported as unknown.
  const index = buildBlockerIndex(issues);
  for (const issue of remaining) {
    const blockers = issue.blockedBy.map((entry) =>
      resolveBlocker(entry, issue.project, index) === null ? `${entry} (unknown)` : entry,
    );
    console.log(
      `  - ${issue.qualifiedId} (${issue.triage}) blocked by: ${blockers.join(', ') || 'none'}`,
    );
  }
  return 'blocked';
}

export async function runCommand(flags: RunFlags): Promise<never> {
  const activeRuns = new Set<RunContext>();
  let startupState: CommandStartup | null = null;

  const shutdownHandle = registerShutdownHandlers({
    onForceStop: () => {
      if (!startupState) return;
      for (const ctx of activeRuns) recordInterruptedRun(ctx, startupState.root, startupState.labels);
    },
  });

  const startup = startupCommand({ configOverrides: flags.config, stages: ['implement', 'verifyFix', 'review', 'reviewFix'] });
  startupState = startup;
  const { root, config, labels, cliFlags, workRoot, verifyCmd } = startup;

  // One mutating invocation per repo (runs race the rolling worktree and issue
  // triage). Dry-runs are read-only and exempt. Released via the exit hook so
  // every process.exit/failStop path drops it.
  if (!flags.dryRun) {
    let releaseLock: () => void;
    try {
      releaseLock = acquireInvocationLock(root);
    } catch (error) {
      failStop('another loop invocation is running', {
        details: String(error instanceof Error ? error.message : error).split('\n'),
      });
    }
    process.once('exit', () => releaseLock());
  }

  warnIfBudgetCannotSeeAllCost(config, cliFlags, flags.budgetUsd);
  const notify: Notifier = createNotifier(config.webhooks, { repoRoot: root, project: flags.project });

  const discover = (base: string): IssueRecord[] => {
    try {
      return discoverIssues(config.issuesDir, base);
    } catch (error) {
      failStop('issue discovery failed', {
        details: String(error instanceof Error ? error.message : error).split('\n'),
      });
    }
  };

  let allIssues = discover(workRoot);
  reportDanglingBlockers(allIssues);
  reportUnknownTriage(allIssues, labels);

  let projectFilter: ((issue: IssueRecord) => boolean) | null = null;
  if (flags.project) {
    try {
      projectFilter = resolveProjectFilter(allIssues, flags.project);
    } catch (error) {
      failStop(`cannot resolve project "${flags.project}"`, {
        details: String(error instanceof Error ? error.message : error).split('\n'),
      });
    }
  }

  if (flags.unblock) {
    const transitions = unblockNeedsHumanIssues(allIssues, projectFilter, { labels, dryRun: flags.dryRun });
    if (transitions.length === 0) {
      console.log(`[loop] --unblock: no ${labels.readyForHuman} issues${flags.project ? ` in project "${flags.project}"` : ''}.`);
    }
    for (const transition of transitions) {
      const verb = flags.dryRun ? 'would unblock' : '--unblock:';
      console.log(
        `[loop] ${verb} ${transition.qualifiedId} ${transition.fromLabel} -> ${transition.toLabel} (resume at ${transition.resumeStage})`,
      );
    }
    if (!flags.dryRun) allIssues = discover(workRoot);
  }

  let state: LoopState = loadState(root);
  const allUsage: StageUsage[] = [];

  if (flags.dryRun) {
    const next = pickNextIssue(allIssues, labels, projectFilter ?? undefined);
    if (!next) {
      const reason = printNoRunnableIssues(allIssues, startup, flags.project);
      saveState(root, { ...state, stoppedReason: reason });
      process.exit(0);
    }
    const entry = resolveResumeStage(next, labels);
    const promptContext: PromptContext = {
      reviewSkill: config.reviewSkill,
      tddSkill: config.tddSkill,
      specRelPath: resolveIssueSpec(next, config, workRoot, root),
      labels: { inProgress: labels.inProgress, done: labels.done },
      verifyCmd: resolveProjectVerifyCmd(config, next.project) ?? verifyCmd,
      // Dry-run stays read-only: show the path only when the file exists.
      projectNotesPath: existsSync(projectNotesPath(root, next.project))
        ? projectNotesPath(root, next.project)
        : null,
    };
    console.log(`\n${badge(`ITERATION ${state.iterations + 1}`)} ${styleStage(next.qualifiedId)} — ${next.title}\n`);
    if (entry !== 'implement') {
      console.log(`[loop] would resume at stage "${entry}" (lastStage checkpoint).\n`);
    }
    console.log(buildImplementPrompt(next, { handoff: readHandoff(root, next) }, promptContext));
    process.exit(0);
  }

  if (config.maxParallelRuns === 1) {
    await runSerialLoop();
  } else {
    await runParallelLoop();
  }
  // Both loops exit the process themselves.
  process.exit(0);

  // --- serial (today's behavior) ------------------------------------------

  async function runSerialLoop(): Promise<never> {
    let issuesCompletedThisRun = 0;
    let issuesEscalatedThisRun = 0;
    /** Set when a limit wait ends: resume the dead session on the re-claimed issue. */
    let pendingResume: { qualifiedId: string; stage: PipelineStageName; sessionId: string } | null = null;

    const finishRun = async (
      stopReason: string,
      options: { code?: number; saveReason?: boolean } = {},
    ): Promise<never> => {
      if (options.saveReason ?? true) saveState(root, { ...state, stoppedReason: stopReason });
      await notify({
        event: 'run-completed',
        stopReason,
        issuesProcessed: issuesCompletedThisRun,
        issuesEscalated: issuesEscalatedThisRun,
        issuesDelegated: countDelegated(discover(workRoot), labels),
        usage: allUsage,
      });
      printUsageTotals(allUsage);
      const tone = stopReason === 'all-complete' ? 'good' : options.code ? 'bad' : 'caution';
      console.log(`\n${badge(`STOPPED ${stopReason.toUpperCase()}`, tone)} ${issuesCompletedThisRun} issue(s) completed this invocation.`);
      process.exit(options.code ?? 0);
    };

    while (!shutdownHandle.isShuttingDown()) {
      if (shutdownHandle.isStopRequested()) {
        console.log('\n[loop] graceful stop: current task finished, exiting before the next issue.');
        return finishRun('stopped-by-user');
      }

      if (flags.budgetUsd !== null && totalKnownCostUsd(allUsage) >= flags.budgetUsd) {
        console.log(
          `\n[loop] budget reached ($${totalKnownCostUsd(allUsage).toFixed(2)} of $${flags.budgetUsd.toFixed(2)} reported spend) — stopping before the next claim.`,
        );
        return finishRun('budget-reached');
      }

      const issues = discover(workRoot);
      const next = pickNextIssue(issues, labels, projectFilter ?? undefined);

      if (!next) {
        const reason = printNoRunnableIssues(issues, startup, flags.project);
        return finishRun(reason);
      }

      // Probed against the issue loop is about to claim: an outage now would
      // make every remaining issue fail identically, three fix cycles apiece.
      const preflight = runPreflight(config, next.project, workRoot, resolveProjectEnv(config, next.project));
      if (!preflight.ready) {
        printPreflightFailure(next.project, preflight);
        saveState(root, { ...state, stoppedReason: 'preflight-failed' });
        await notify({
          event: 'run-completed',
          stopReason: 'preflight-failed',
          issuesProcessed: issuesCompletedThisRun,
          issuesEscalated: issuesEscalatedThisRun,
          issuesDelegated: countDelegated(discover(workRoot), labels),
          usage: allUsage,
        });
        printUsageTotals(allUsage);
        failStop('the environment the verify command needs is not ready', {
          details: describePreflightFailure(preflight),
        });
      }

      warnIfReviewDiffLimited(workRoot);
      const entry = resolveResumeStage(next, labels);
      console.log(`\n${badge(`ITERATION ${state.iterations + 1}`)} ${styleStage(next.qualifiedId)} — ${next.title}\n`);

      const resumeSession =
        pendingResume && pendingResume.qualifiedId === next.qualifiedId
          ? { stage: pendingResume.stage, sessionId: pendingResume.sessionId }
          : null;
      pendingResume = null;

      const result = await runIssuePipeline(next, {
        entryStage: entry,
        iteration: state.iterations + 1,
        root,
        cwd: workRoot,
        config,
        cliFlags,
        labels,
        verifyCmd: resolveProjectVerifyCmd(config, next.project) ?? verifyCmd,
        ...(resumeSession ? { resumeSession } : {}),
        liveOutput: !flags.quiet,
        onRunContext: (ctx) => activeRuns.add(ctx),
      });
      activeRuns.clear();
      allUsage.push(...result.usageEntries);

      state = {
        iterations: state.iterations + 1,
        lastIssueId: next.qualifiedId,
        lastRunAt: new Date().toISOString(),
        stoppedReason: null,
      };

      // A park is a deliberate stop, not a failure: the issue already carries a
      // runnable role and a checkpoint, so end the run cleanly.
      if (result.outcome === 'parked') return finishRun('stopped-by-user');

      if (result.fatal) {
        // Wait policy: the issue keeps its resume checkpoint and a runnable
        // role — sleep until the limit lifts, then re-claim it right here.
        const limitPolicy = result.usageLimited ? limitPolicyFor(config, next.project, result.usageLimitDetails) : null;
        if (limitPolicy === 'wait') {
          saveState(root, { ...state, stoppedReason: null });
          const waited = await waitForLimitReset(
            mergeLimitWait(
              null,
              result.usageLimitDetails ?? { scope: 'session', resetsAtMs: null },
              REAL_CLOCK.now(),
            ),
            REAL_CLOCK,
            () => shutdownHandle.isStopRequested() || shutdownHandle.isShuttingDown(),
          );
          if (waited === 'resumed') {
            // Same cwd (rolling worktree), so the dead session is resumable.
            if (result.lastStage && result.limitSessionId) {
              pendingResume = {
                qualifiedId: next.qualifiedId,
                stage: result.lastStage,
                sessionId: result.limitSessionId,
              };
            }
            continue;
          }
          if (waited === 'cancelled') return finishRun('stopped-by-user');
        }
        if (limitPolicy !== null) {
          // Stop policy, or a wait that gave up — say so before the run ends.
          await notify(usageLimitEvent(result.usageLimitDetails, limitPolicy, result.usageEntries));
        }

        if (ESCALATION_OUTCOMES.has(result.outcome)) {
          issuesEscalatedThisRun += 1;
          await notify({
            event: 'issue-escalated',
            issue: { qualifiedId: next.qualifiedId, title: next.title },
            outcome: result.outcome,
            usage: result.usageEntries,
          });
        }
        saveState(root, { ...state, stoppedReason: result.outcome });
        await notify({
          event: 'run-completed',
          stopReason: result.outcome,
          issuesProcessed: issuesCompletedThisRun,
          issuesEscalated: issuesEscalatedThisRun,
          issuesDelegated: countDelegated(discover(workRoot), labels),
          usage: allUsage,
        });
        printUsageTotals(allUsage);
        failStop(result.fatal.reason, {
          ...(result.fatal.code !== undefined ? { code: result.fatal.code } : {}),
          ...(result.fatal.details ? { details: result.fatal.details } : {}),
        });
      }

      issuesCompletedThisRun += 1;
      await notify({
        event: 'issue-completed',
        issue: { qualifiedId: next.qualifiedId, title: next.title },
        usage: result.usageEntries,
      });
      const hitIterationCap =
        Number.isFinite(flags.maxIterations) && issuesCompletedThisRun >= flags.maxIterations;
      saveState(root, hitIterationCap ? { ...state, stoppedReason: 'max-iterations' } : state);
      console.log(`\nCompleted ${next.qualifiedId}.`);

      if (flags.once || hitIterationCap) {
        if (hitIterationCap) {
          console.log(`Reached max iterations (${flags.maxIterations}) for this invocation.`);
        }
        // State was already saved above (stoppedReason stays null for --once).
        return finishRun(flags.once ? 'once-complete' : 'max-iterations', { saveReason: false });
      }
    }

    saveState(root, { ...state, stoppedReason: 'interrupted' });
    process.exit(130);
  }

  // --- parallel (worker pool over per-issue worktrees) ----------------------

  async function runParallelLoop(): Promise<never> {
    type Claim = { issue: IssueRecord; entry: PipelineStageName; iteration: number };

    const claimed = new Set<string>();
    const failures: string[] = [];
    let stopClaiming = false;
    let claimsMade = 0;
    let completedCount = 0;
    let escalatedCount = 0;
    /** Set on the first non-escalation failure — the pool drains and never resumes past it. */
    let hardFailure = false;
    /** Set when a readiness probe failed; outranks pipeline failures, which would be symptoms of it. */
    let preflightFailure: PreflightResult | null = null;
    let budgetStopped = false;
    /** Pending wait-policy usage limit; consumed after the pool drains. */
    let limitWait: LimitWait | null = null;

    const notifyEscalated = async (qualifiedId: string, title: string, outcome: string, usage: StageUsage[]): Promise<void> => {
      escalatedCount += 1;
      await notify({ event: 'issue-escalated', issue: { qualifiedId, title }, outcome, usage });
    };

    const workerStatus = new Map<number, { qualifiedId: string; stage: string; startedAt: number; logPath: string }>();
    const statusTimer = setInterval(() => {
      const entries: WorkerStatusEntry[] = [...workerStatus.values()].map((worker) => ({
        qualifiedId: worker.qualifiedId,
        stage: worker.stage,
        elapsedMs: Date.now() - worker.startedAt,
        logPath: worker.logPath,
      }));
      console.log(formatWorkerStatusBlock(entries, config.maxParallelRuns));
    }, WORKER_STATUS_INTERVAL_MS);

    const claim = (): Claim | null => {
      if (stopClaiming || shutdownHandle.isStopRequested() || shutdownHandle.isShuttingDown()) return null;
      if (Number.isFinite(flags.maxIterations) && claimsMade >= flags.maxIterations) return null;
      if (flags.once && claimsMade >= 1) return null;
      if (flags.budgetUsd !== null && totalKnownCostUsd(allUsage) >= flags.budgetUsd) {
        if (!budgetStopped) {
          budgetStopped = true;
          console.log(
            `[loop] budget reached ($${totalKnownCostUsd(allUsage).toFixed(2)} of $${flags.budgetUsd.toFixed(2)} reported spend) — no new issues will be claimed.`,
          );
        }
        return null;
      }

      let issues: IssueRecord[];
      try {
        issues = discoverIssues(config.issuesDir, workRoot);
      } catch {
        return null;
      }
      const next = pickNextIssue(issues, labels, (issue) => {
        if (claimed.has(issue.qualifiedId)) return false;
        return projectFilter ? projectFilter(issue) : true;
      });
      if (!next) return null;

      // An outage would make every claimed issue fail identically, so stop
      // claiming and let in-flight workers finish rather than feeding the fire.
      const preflight = runPreflight(config, next.project, workRoot, resolveProjectEnv(config, next.project));
      if (!preflight.ready) {
        printPreflightFailure(next.project, preflight);
        preflightFailure = preflight;
        stopClaiming = true;
        return null;
      }

      // Synchronous claim: resolve the resume entry from the pre-claim triage,
      // then flip to in-progress and record the claim — no await in between.
      const entry = resolveResumeStage(next, labels);
      markInProgress(next, labels);
      claimed.add(next.qualifiedId);
      claimsMade += 1;
      return { issue: next, entry, iteration: state.iterations + claimsMade };
    };

    const work = async (item: Claim, workerIndex: number): Promise<void> => {
      const { issue, entry } = item;
      const qid = issue.qualifiedId;

      // Isolate: fresh per-issue worktree, or re-attach to the leftover from a
      // previous merge conflict (the only copy of the unmerged work).
      let worktreeDir: string;
      let reattached = false;
      const created = createIssueWorktree(root, workRoot, qid);
      if (created.ok) {
        worktreeDir = created.worktree.dir;
      } else {
        const leftover = listLeftoverIssueWorktrees(root).find((entry_) => entry_.qualifiedId === qid);
        if (!leftover) {
          console.error(`[loop] cannot isolate ${qid}: ${created.error}`);
          failures.push(`${qid}: worktree creation failed — ${created.error}`);
          setIssueTriage(issue, 'agentFailed', labels);
          return;
        }
        console.log(`[loop] re-attaching to leftover worktree for ${qid} at ${leftover.dir}.`);
        worktreeDir = leftover.dir;
        reattached = true;
      }

      if (config.installCmd && !reattached) {
        console.log(`[loop] running \`${config.installCmd}\` in ${worktreeDir}…`);
        const install = shell(config.installCmd, worktreeDir);
        if (!install.ok) {
          console.warn(`[loop] \`${config.installCmd}\` failed in ${worktreeDir}: ${install.output.trim().slice(0, 300)}`);
        }
      }

      const baseSha = getHeadSha(worktreeDir);
      const worktreeIssue = discoverIssues(config.issuesDir, worktreeDir).find(
        (candidate) => candidate.qualifiedId === qid,
      );
      if (!worktreeIssue) {
        failures.push(`${qid}: issue file not found in its worktree ${worktreeDir}`);
        setIssueTriage(issue, 'agentFailed', labels);
        return;
      }

      workerStatus.set(workerIndex, { qualifiedId: qid, stage: entry, startedAt: Date.now(), logPath: '' });
      let runCtx: RunContext | null = null;
      const issueVerifyCmd = resolveProjectVerifyCmd(config, issue.project) ?? verifyCmd;

      let result: IssuePipelineResult;
      try {
        result = await runIssuePipeline(worktreeIssue, {
          entryStage: entry,
          iteration: item.iteration,
          root,
          cwd: worktreeDir,
          config,
          cliFlags,
          labels,
          verifyCmd: issueVerifyCmd,
          liveOutput: false,
          onStage: (_stage, label) => {
            const status = workerStatus.get(workerIndex);
            if (status) status.stage = label;
          },
          onRunContext: (ctx) => {
            runCtx = ctx;
            activeRuns.add(ctx);
            const status = workerStatus.get(workerIndex);
            if (status) status.logPath = path.relative(root, ctx.agentLogPath);
          },
        });
      } finally {
        if (runCtx) activeRuns.delete(runCtx);
        workerStatus.delete(workerIndex);
      }

      allUsage.push(...result.usageEntries);
      let waitPolicyLimit = false;
      if (result.usageLimited) {
        if (limitPolicyFor(config, issue.project, result.usageLimitDetails) === 'wait') {
          // Wait policy: drain in-flight siblings (they're hitting the same
          // wall), then sleep and resume. The interrupted attempt is
          // re-claimable and doesn't spend --once/--max-iterations.
          waitPolicyLimit = true;
          limitWait = mergeLimitWait(
            limitWait,
            result.usageLimitDetails ?? { scope: 'session', resetsAtMs: null },
            REAL_CLOCK.now(),
          );
          claimed.delete(qid);
          claimsMade -= 1;
          stopClaiming = true;
          console.error('[loop] usage limit hit — draining in-flight issues, then waiting for the reset.');
        } else {
          console.error('[loop] usage limit hit — no new issues will be claimed this run.');
          stopClaiming = true;
          await notify(usageLimitEvent(result.usageLimitDetails, 'stop', result.usageEntries));
        }
      }

      // Merge back on ANY outcome that produced commits (reattached leftovers
      // always attempt — their prior commits are still unmerged).
      const endSha = getHeadSha(worktreeDir);
      const producedCommits = reattached || (baseSha !== null && endSha !== null && baseSha !== endSha);
      let mergeConflicted = false;
      let semanticConflict = false;

      if (producedCommits) {
        // Drop the uncommitted in-progress claim edit on the rolling copy so
        // the merge isn't blocked by local changes; the merged branch (and the
        // outcome sync below) carries the authoritative triage state.
        shell(`git checkout -- ${JSON.stringify(issue.relPath)}`, workRoot);

        const targetRef = startup.rolling.rollingBranch ?? getCurrentBranchName(workRoot) ?? 'HEAD';
        const preMergeSha = getHeadSha(workRoot);
        const merge = mergeIssueWorktree(workRoot, targetRef, qid);
        if (merge.ok) {
          // A sibling may have merged since this worktree was cut: a textually
          // clean combination can still be semantically broken, and only the
          // merged state shows it. Re-verify then (never from in-session
          // evidence — no session saw this merged tree); rewind on failure so
          // the rolling branch stays green. When nothing merged in between,
          // the per-worktree verify already covered this exact tree.
          const rollingAdvanced = reattached || (baseSha !== null && preMergeSha !== null && preMergeSha !== baseSha);
          const postMergeVerify = rollingAdvanced && !waitPolicyLimit && result.fatal === null
            ? await runVerifyCommand(issueVerifyCmd, workRoot, path.join(result.runDir, 'post-merge.verify.log'), {
                stageLabel: `${qid}-verify`,
                heartbeatIntervalMs: config.heartbeatIntervalMs,
              })
            : null;

          if (postMergeVerify && !postMergeVerify.ok && preMergeSha !== null) {
            semanticConflict = true;
            shell(`git reset --hard ${preMergeSha}`, workRoot);
            const rollingIssue = discoverIssues(config.issuesDir, workRoot).find(
              (candidate) => candidate.qualifiedId === qid,
            );
            if (rollingIssue) {
              escalateIssueForSemanticConflict(rollingIssue, {
                branch: `loop/issue/${qid}`,
                worktreeDir,
                verifyCmd: issueVerifyCmd,
                verifyLogPath: path.relative(root, path.join(result.runDir, 'post-merge.verify.log')),
                labels,
              });
              await notifyEscalated(qid, issue.title, 'semantic-conflict', result.usageEntries);
            }
            console.error(
              `[loop] post-merge verify failed for ${qid} — a sibling merge conflicts semantically; merge rewound, worktree kept at ${worktreeDir}. Escalated to ${labels.readyForHuman}.`,
            );
            failures.push(`${qid}: semantic conflict with a sibling merge (worktree kept at ${worktreeDir})`);
          } else {
            if (postMergeVerify) console.log(`[loop] post-merge verify passed for ${qid} (rolling had advanced).`);
            const cleanup = cleanupIssueWorktree(root, qid);
            for (const message of cleanup.messages) console.warn(message);
            console.log(`[loop] merged ${qid} back into ${targetRef}.`);
          }
        } else {
          mergeConflicted = true;
          const rollingIssue = discoverIssues(config.issuesDir, workRoot).find(
            (candidate) => candidate.qualifiedId === qid,
          );
          if (rollingIssue) {
            escalateIssueForMergeConflict(rollingIssue, {
              branch: `loop/issue/${qid}`,
              worktreeDir,
              conflictingFiles: merge.conflictingFiles,
              labels,
            });
            await notifyEscalated(qid, issue.title, 'merge-conflict', result.usageEntries);
          }
          console.error(
            `[loop] merge conflict for ${qid} — worktree/branch left at ${worktreeDir} (files: ${merge.conflictingFiles.join(', ') || 'unknown'}). Escalated to ${labels.readyForHuman}.`,
          );
          failures.push(`${qid}: merge conflict (worktree kept at ${worktreeDir})`);
        }
      } else {
        const cleanup = cleanupIssueWorktree(root, qid);
        for (const message of cleanup.messages) console.warn(message);
      }

      // Sync the outcome to the rolling copy: triage-only changes are never
      // committed, so the merge alone can't be relied on to carry them.
      if (!mergeConflicted && !semanticConflict) {
        const rollingIssue = discoverIssues(config.issuesDir, workRoot).find(
          (candidate) => candidate.qualifiedId === qid,
        );
        if (rollingIssue) {
          setIssueTriage(rollingIssue, result.finalRole, labels);
          if (result.lastStage) setIssueStage(rollingIssue, result.lastStage);
          else clearIssueStage(rollingIssue);
        }
      }

      if (semanticConflict) {
        // Recorded above; the pool keeps claiming (escalation semantics).
      } else if (result.outcome === 'parked') {
        // Deliberate stop at a stage boundary: not a failure, and the issue is
        // already checkpointed. Let in-flight siblings reach their own boundary.
        stopClaiming = true;
      } else if (waitPolicyLimit) {
        console.log(`[loop] ${qid} paused on the usage limit — it will be re-claimed after the reset.`);
      } else if (result.fatal) {
        console.error(`[loop] ${qid} stopped: ${result.outcome} — ${result.fatal.reason}`);
        failures.push(`${qid}: ${result.outcome}`);
        if (ESCALATION_OUTCOMES.has(result.outcome)) {
          await notifyEscalated(qid, issue.title, result.outcome, result.usageEntries);
        } else {
          if (!hardFailure && workerStatus.size > 0) {
            console.error(
              `[loop] draining: no new issues will be claimed after ${qid}'s ${result.outcome}; in-flight issues run to completion.`,
            );
          }
          hardFailure = true;
          stopClaiming = true;
        }
      } else {
        completedCount += 1;
        await notify({ event: 'issue-completed', issue: { qualifiedId: qid, title: issue.title }, usage: result.usageEntries });
        console.log(`\nCompleted ${qid}.`);
      }
    };

    const waitCancelled = (): boolean => shutdownHandle.isStopRequested() || shutdownHandle.isShuttingDown();

    try {
      // Pool → (optional limit wait) → pool again, until there is nothing to
      // wait for. Hard failures and stop requests never resume past the wait.
      for (;;) {
        await runWorkerPool(config.maxParallelRuns, claim, work);
        if (!limitWait || hardFailure || budgetStopped || waitCancelled()) break;
        // Annotated: TS narrows the closure-mutated binding to `never` here.
        const wait: LimitWait = limitWait;
        limitWait = null;
        const waited = await waitForLimitReset(wait, REAL_CLOCK, waitCancelled);
        if (waited !== 'resumed') {
          if (waited === 'gave-up') {
            failures.push('usage-limit: implausible reported reset time — stopped instead of waiting');
            await notify(
              usageLimitEvent({ scope: wait.scope, resetsAtMs: wait.resetsAtMs }, 'wait', allUsage),
            );
          }
          break;
        }
        stopClaiming = false;
      }
    } finally {
      clearInterval(statusTimer);
    }

    state = {
      iterations: state.iterations + claimsMade,
      lastIssueId: state.lastIssueId,
      lastRunAt: new Date().toISOString(),
      stoppedReason: failures.length > 0 ? 'worker-failures' : budgetStopped ? 'budget-reached' : null,
    };
    saveState(root, state);
    printUsageTotals(allUsage);

    let stopReason: string;
    // Outranks pipeline failures: issues that failed after an outage are its
    // symptoms, and reporting them as the cause sends the operator hunting.
    if (preflightFailure) stopReason = 'preflight-failed';
    else if (failures.length > 0) stopReason = 'worker-failures';
    else if (budgetStopped) stopReason = 'budget-reached';
    else if (waitCancelled()) stopReason = 'stopped-by-user';
    else if (claimsMade === 0) stopReason = printNoRunnableIssues(discover(workRoot), startup, flags.project);
    else if (flags.once) stopReason = 'once-complete';
    else if (Number.isFinite(flags.maxIterations) && claimsMade >= flags.maxIterations) stopReason = 'max-iterations';
    else stopReason = 'all-complete';

    await notify({
      event: 'run-completed',
      stopReason,
      issuesProcessed: completedCount + failures.length,
      issuesEscalated: escalatedCount,
      issuesDelegated: countDelegated(discover(workRoot), labels),
      usage: allUsage,
    });

    if (preflightFailure) {
      failStop('the environment the verify command needs is not ready', {
        details: [...describePreflightFailure(preflightFailure), ...failures],
      });
    }

    if (failures.length > 0) {
      failStop(`${failures.length} issue(s) did not complete`, { details: failures });
    }

    const outcomeTone = stopReason === 'all-complete' ? 'good' : failures.length > 0 ? 'bad' : 'caution';
    console.log(
      `\n${badge(`STOPPED ${stopReason.toUpperCase()}`, outcomeTone)} ` +
        `${completedCount}/${claimsMade} claimed issue(s) finished.`,
    );
    process.exit(0);
  }
}
