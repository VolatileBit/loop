/**
 * The goal loop: **plan → drain → evaluate** rounds until a fresh session
 * judges the goal reached (or the loop hits a wall/guard). No process.exit —
 * commands/goal.ts wraps this and owns the exit code.
 *
 * - plan (only when nothing is runnable): a fresh session in the rolling
 *   worktree — so it investigates the *merged* state — writes the smallest
 *   next batch of issue files (capped at `goal.maxIssuesPerRound`).
 * - drain: the regular per-issue pipeline works the backlog with the
 *   declared-verify contract (see pipeline/run-issue.ts GoalPipelineContext) —
 *   serially in the rolling worktree, or with `maxParallelRuns` > 1 through
 *   the worker pool over per-issue worktrees (dependencies from the plan's
 *   `## Blocked by` edges gate what runs concurrently). Escalations park the
 *   issue and the drain continues; hard failures stop the goal run.
 * - evaluate: loop mechanically re-runs every declared verify command against
 *   the merged state, then a fresh session judges the goal against the
 *   observable repo — `reached` exits, `not-reached` feeds its gaps into the
 *   next plan, `blocked` stops for a human.
 *
 * Escalations replan within a budget: a plan session may supersede an
 * escalated issue with a genuinely different approach, up to `supersedeLimit`
 * replacements per lineage (default 3, `goal.supersedeLimit` /
 * `--supersede-limit`); failing past that budget stops the goal as blocked.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describeAgentFailure, extractAgentResultText } from '../agent/run-agent.js';
import { agentStageUsageEntries } from '../agent/usage.js';
import type { StageCliFlags } from '../config/stage-settings.js';
import type { LoopConfig, PipelineStageName, UsageLimitsConfig } from '../config/types.js';
import type { TriageLabels } from '../config/triage-labels.js';
import { getHeadSha } from '../git/status.js';
import { discoverIssues } from '../issues/discovery.js';
import { escalateIssueForMergeConflict, escalateIssueForSemanticConflict } from '../issues/escalation.js';
import { markInProgress, setIssueTriage } from '../issues/lifecycle.js';
import { pickNextIssue, reportDanglingBlockers } from '../issues/scheduling.js';
import { printPreflightFailure, runPreflight } from '../verify/preflight.js';
import { resolveProjectEnv } from '../config/project-settings.js';
import { resolveResumeStage } from '../issues/resolve-resume-stage.js';
import type { IssueRecord } from '../issues/types.js';
import { usageLimitEvent, type Notifier } from '../notify/webhooks.js';
import { resolvePipelineDeps, type PipelineDeps } from '../pipeline/deps.js';
import { runIssuePipeline, type GoalPipelineContext } from '../pipeline/run-issue.js';
import { shell } from '../shared/shell.js';
import { mergeLimitWait, waitForLimitReset, REAL_CLOCK, type Clock, type LimitWait } from '../usage/limit-wait.js';
import { totalKnownCostUsd, type StageUsage } from '../usage/tokens.js';
import {
  cleanupIssueWorktree,
  createIssueWorktree,
  listLeftoverIssueWorktrees,
  mergeIssueWorktree,
} from '../worktree/issue-worktree.js';
import { getCurrentBranchName } from '../worktree/rolling-worktree.js';
import { runWorkerPool } from '../worktree/worker-pool.js';
import {
  declaredVerifyPath,
  listDeclaredVerifyCmds,
  loadGoalState,
  readDeclaredVerifyCmd,
  saveGoalState,
  supersedeCount,
  updateLineageFromIssues,
  type GoalPaths,
  type GoalState,
} from './goal.js';
import { buildEvaluatePrompt, buildPlanPrompt, parseGoalVerdict } from './prompts.js';

/** Outcomes the pool safely parks and drains past (mirrors commands/run.ts). */
const ESCALATION_OUTCOMES: ReadonlySet<string> = new Set(['needs-human', 'verify-failed', 'unverifiable']);

/** Verify-failed issues get this many total attempts before parking for a supersede. */
const MAX_VERIFY_FAILED_ATTEMPTS = 2;

export type GoalLoopOptions = {
  root: string;
  workRoot: string;
  /** Base config; the loop derives a goal config with `issuesDir` pointed into the goal folder. */
  config: LoopConfig;
  cliFlags?: StageCliFlags;
  labels: TriageLabels;
  paths: GoalPaths;
  /** Rounds this invocation may run; null = unbounded (warned about upstream). */
  roundLimit: number | null;
  budgetUsd: number | null;
  /** Effective usage-limit policies (flags > `goal.usageLimits` > `usageLimits`, resolved by the caller). */
  usageLimits?: UsageLimitsConfig;
  /** Max replacements per lineage (flag > `goal.supersedeLimit`, resolved by the caller). */
  supersedeLimit?: number;
  liveOutput?: boolean;
  notify: Notifier;
  /** ESC/stop signal (checked between sessions and issues). */
  isStopRequested?: () => boolean;
  clock?: Clock;
  deps?: Partial<PipelineDeps>;
};

export type GoalLoopResult = {
  /** 'reached' | 'blocked' | 'planner-stuck' | 'round-limit' | 'budget-reached' | 'interrupted' | a failure kind. */
  outcome: string;
  rounds: number;
  summary: string;
  issuesProcessed: number;
  issuesEscalated: string[];
  usage: StageUsage[];
};

export async function executeGoalLoop(options: GoalLoopOptions): Promise<GoalLoopResult> {
  const deps = resolvePipelineDeps(options.deps);
  const { root, workRoot, labels, paths } = options;
  const cliFlags = options.cliFlags ?? {};
  const liveOutput = options.liveOutput ?? true;
  const stopRequested = options.isStopRequested ?? (() => false);
  const clock = options.clock ?? REAL_CLOCK;
  const usageLimits = options.usageLimits ?? options.config.usageLimits;
  const supersedeLimit = options.supersedeLimit ?? options.config.goal.supersedeLimit;
  // The goal backlog lives in the goal folder; everything else is the repo config.
  const config: LoopConfig = { ...options.config, issuesDir: paths.issuesDir };

  const state: GoalState = loadGoalState(paths);
  const allUsage: StageUsage[] = [];
  const escalatedIds: string[] = [];
  let issuesProcessed = 0;
  let roundsThisRun = 0;
  let lastGaps: string[] = [];

  const finish = async (outcome: string, summary: string): Promise<GoalLoopResult> => {
    state.status =
      outcome === 'reached'
        ? 'reached'
        : outcome === 'blocked'
          ? 'blocked'
          : outcome === 'planner-stuck'
            ? 'planner-stuck'
            : 'active';
    saveGoalState(paths, state);
    await options.notify({
      event: 'goal-completed',
      goal: paths.slug,
      outcome,
      rounds: state.round,
      summary,
      usage: allUsage,
    });
    return { outcome, rounds: state.round, summary, issuesProcessed, issuesEscalated: escalatedIds, usage: allUsage };
  };

  const roundDir = (round: number): string => path.join(paths.dir, 'rounds', `round-${round}`);

  /**
   * One aux (plan/evaluate) session; returns the final text or a failure
   * outcome. A usage-limit death under the wait policy sleeps until the reset
   * and retries the session (there is no partial state worth checkpointing —
   * the prompt is rebuilt from files either way).
   */
  const runAuxSession = async (
    stage: 'plan' | 'evaluate',
    prompt: string,
    round: number,
  ): Promise<{ ok: true; text: string } | { ok: false; outcome: string; summary: string }> => {
    const dir = roundDir(round);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${stage}.prompt.md`), `${prompt}\n`);
    for (let attempt = 1; ; attempt += 1) {
      const suffix = attempt === 1 ? '' : `.retry-${attempt - 1}`;
      const result = await deps.runAgent(prompt, {
        config,
        cliFlags,
        stage,
        cwd: workRoot,
        logPath: path.join(dir, `${stage}${suffix}.stream.log`),
        stageLabel: `goal-${paths.slug}-${stage}-${round}`,
        liveOutput,
      });
      allUsage.push(...agentStageUsageEntries(`${stage}-${round}`, result));
      if (result.usageLimited) {
        const details = result.usageLimitDetails ?? { scope: 'session' as const, resetsAtMs: null };
        const policy = usageLimits[details.scope];
        if (policy === 'wait') {
          const waited = await waitForLimitReset(
            mergeLimitWait(null, details, clock.now()),
            clock,
            stopRequested,
          );
          if (waited === 'resumed') continue;
          if (waited === 'cancelled') {
            return { ok: false, outcome: 'interrupted', summary: `stopped while waiting out the usage limit (${stage} session)` };
          }
        }
        await options.notify(usageLimitEvent(details, policy, allUsage));
        return { ok: false, outcome: 'usage-limit', summary: `usage limit hit during the ${stage} session` };
      }
      if (result.stuckReason === 'interrupted') return { ok: false, outcome: 'interrupted', summary: `${stage} session interrupted` };
      if (result.stuckReason) return { ok: false, outcome: result.stuckReason, summary: `${stage} session got stuck (${result.stuckReason})` };
      if (!result.ok) {
        return { ok: false, outcome: 'agent-failed', summary: `${stage} session ${describeAgentFailure(result)}` };
      }
      return { ok: true, text: extractAgentResultText(result) };
    }
  };

  const discover = (): ReturnType<typeof discoverIssues> => discoverIssues(config.issuesDir, workRoot);

  for (;;) {
    if (stopRequested()) return finish('interrupted', 'stop requested');
    if (options.budgetUsd !== null && totalKnownCostUsd(allUsage) >= options.budgetUsd) {
      return finish('budget-reached', `reported spend crossed $${options.budgetUsd.toFixed(2)}`);
    }
    if (options.roundLimit !== null && roundsThisRun >= options.roundLimit) {
      return finish('round-limit', `${options.roundLimit} round(s) this invocation`);
    }

    roundsThisRun += 1;
    state.round += 1;
    saveGoalState(paths, state);
    const round = state.round;
    console.log(`\n=== Goal ${paths.slug} — round ${round} ===\n`);

    // --- plan (only when nothing is runnable) ------------------------------

    let issues = discover();
    reportDanglingBlockers(issues);
    if (!pickNextIssue(issues, labels)) {
      console.log(`[loop] nothing runnable — planning the next batch (max ${config.goal.maxIssuesPerRound}).`);
      const exhaustedLineageIds = [...new Set(Object.values(state.lineage))].filter(
        (root) => supersedeCount(state.lineage, root) >= supersedeLimit,
      );
      const plan = await runAuxSession(
        'plan',
        buildPlanPrompt({
          slug: paths.slug,
          goalDocPath: paths.goalDocPath,
          planDocPath: paths.planDocPath,
          issuesProjectDir: paths.issuesProjectDir,
          verifyNotesPath: paths.verifyNotesPath,
          maxIssues: config.goal.maxIssuesPerRound,
          supersedeLimit,
          readyLabel: labels.readyForAgent,
          gaps: lastGaps,
          escalatedIds: issues
            .filter((issue) => issue.triage === labels.readyForHuman)
            .map((issue) => issue.id),
          exhaustedLineageIds,
        }),
        round,
      );
      if (!plan.ok) return finish(plan.outcome, plan.summary);

      const { lineage, overLimit } = updateLineageFromIssues(paths, state.lineage, supersedeLimit);
      state.lineage = lineage;
      saveGoalState(paths, state);
      if (overLimit.length > 0) {
        return finish(
          'blocked',
          `the plan superseded lineage(s) ${overLimit.join(', ')} past the limit of ${supersedeLimit} — repeated failures on the same problem need a human`,
        );
      }

      issues = discover();
      // A plan session that cross-references its new issues by link or path
      // would otherwise read as "planner-stuck" with no cause given.
      reportDanglingBlockers(issues);
      if (!pickNextIssue(issues, labels)) {
        // The planner produced nothing runnable. Evaluate once: the goal may
        // simply already be satisfied; otherwise the planner is stuck.
        const evaluated = await evaluateRound(round);
        if (!evaluated.ok) return finish(evaluated.outcome, evaluated.summary);
        if (evaluated.verdict.status === 'reached') return finish('reached', evaluated.verdict.summary);
        if (evaluated.verdict.status === 'blocked') return finish('blocked', evaluated.verdict.summary);
        return finish('planner-stuck', 'the plan session produced no runnable issues while gaps remain');
      }
    }

    // --- drain --------------------------------------------------------------

    const drained = config.maxParallelRuns > 1 ? await drainParallel(round) : await drainSerial(round);
    if (drained !== null) return finish(drained.outcome, drained.summary);

    // --- evaluate ----------------------------------------------------------

    const evaluated = await evaluateRound(round);
    if (!evaluated.ok) return finish(evaluated.outcome, evaluated.summary);
    if (evaluated.verdict.status === 'reached') return finish('reached', evaluated.verdict.summary);
    if (evaluated.verdict.status === 'blocked') return finish('blocked', evaluated.verdict.summary);
    lastGaps = evaluated.verdict.gaps;
    console.log(`[goal ${paths.slug}] not reached — ${evaluated.verdict.gaps.length} gap(s) feed the next plan.`);
  }

  function goalContextFor(issueId: string): GoalPipelineContext {
    return {
      goalDocPath: paths.goalDocPath,
      declareVerifyPath: declaredVerifyPath(paths, issueId),
      verifyNotesPath: paths.verifyNotesPath,
      readDeclaredVerifyCmd: () => readDeclaredVerifyCmd(paths, issueId),
    };
  }

  function budgetCrossed(): boolean {
    return options.budgetUsd !== null && totalKnownCostUsd(allUsage) >= options.budgetUsd;
  }

  /**
   * Escalation bookkeeping shared by both drains: record the attempt, give
   * verify-failed issues one silent retry then park them for a supersede, and
   * stop the goal when the lineage has burned its replan budget. Returns the
   * terminal outcome when the goal must stop, null to keep draining.
   */
  async function handleEscalation(
    issue: IssueRecord,
    outcome: string,
    usage: StageUsage[],
  ): Promise<{ outcome: string; summary: string } | null> {
    state.attempts[issue.id] = (state.attempts[issue.id] ?? 0) + 1;
    saveGoalState(paths, state);

    // Self-healing, bounded: a verify-failed issue keeps its runnable role,
    // so its first failure is a scheduled retry (fresh cycle budget next
    // round), not an escalation. A repeat gets parked for the planner to
    // supersede — retrying the same approach forever heals nothing.
    if (outcome === 'verify-failed' && state.attempts[issue.id]! < MAX_VERIFY_FAILED_ATTEMPTS) {
      console.log(
        `[goal ${paths.slug}] ${issue.qualifiedId} verify-failed (attempt ${state.attempts[issue.id]}/${MAX_VERIFY_FAILED_ATTEMPTS}) — retrying next round with a fresh fix budget.`,
      );
      return null;
    }
    if (outcome === 'verify-failed') {
      setIssueTriage(issue, 'readyForHuman', labels);
      console.log(
        `[goal ${paths.slug}] ${issue.qualifiedId} verify-failed ${MAX_VERIFY_FAILED_ATTEMPTS} times — parked for the planner to supersede.`,
      );
    }

    escalatedIds.push(issue.qualifiedId);
    await options.notify({
      event: 'issue-escalated',
      issue: { qualifiedId: issue.qualifiedId, title: issue.title },
      outcome,
      usage,
    });
    const lineageRoot = state.lineage[issue.id];
    if (lineageRoot !== undefined && supersedeCount(state.lineage, lineageRoot) >= supersedeLimit) {
      return {
        outcome: 'blocked',
        summary: `${issue.qualifiedId} escalated (${outcome}) and its lineage already burned all ${supersedeLimit} replans — a human has to look`,
      };
    }
    console.log(`[goal ${paths.slug}] ${issue.qualifiedId} escalated (${outcome}) — continuing the drain.`);
    return null;
  }

  /** One issue at a time in the rolling worktree. Null = drained; else the terminal outcome. */
  async function drainSerial(round: number): Promise<{ outcome: string; summary: string } | null> {
    const attempted = new Set<string>();
    /** Set when a limit wait ends: resume the dead session on the re-claimed issue. */
    let pendingResume: { qualifiedId: string; stage: PipelineStageName; sessionId: string } | null = null;
    for (;;) {
      if (stopRequested()) return { outcome: 'interrupted', summary: 'stop requested mid-drain' };
      if (budgetCrossed()) {
        return { outcome: 'budget-reached', summary: `reported spend crossed $${options.budgetUsd!.toFixed(2)}` };
      }

      const next = pickNextIssue(discover(), labels, (issue) => !attempted.has(issue.qualifiedId));
      if (!next) return null;
      const preflight = runPreflight(config, next.project, workRoot, resolveProjectEnv(config, next.project));
      if (!preflight.ready) {
        printPreflightFailure(next.project, preflight);
        return {
          outcome: 'preflight-failed',
          summary: `environment not ready: ${preflight.probe?.message ?? 'readiness probe failed'}`,
        };
      }
      attempted.add(next.qualifiedId);

      const entry = resolveResumeStage(next, labels);
      const resumeSession =
        pendingResume && pendingResume.qualifiedId === next.qualifiedId
          ? { stage: pendingResume.stage, sessionId: pendingResume.sessionId }
          : null;
      pendingResume = null;

      console.log(`\n[goal ${paths.slug}] issue ${next.qualifiedId} — ${next.title}\n`);
      const result = await runIssuePipeline(next, {
        entryStage: entry,
        iteration: round,
        root,
        cwd: workRoot,
        config,
        cliFlags,
        labels,
        verifyCmd: '',
        goal: goalContextFor(next.id),
        ...(resumeSession ? { resumeSession } : {}),
        liveOutput,
        deps,
      });
      allUsage.push(...result.usageEntries);

      if (result.usageLimited) {
        const details = result.usageLimitDetails ?? { scope: 'session' as const, resetsAtMs: null };
        const policy = usageLimits[details.scope];
        if (policy === 'wait') {
          const waited = await waitForLimitReset(
            mergeLimitWait(null, details, clock.now()),
            clock,
            stopRequested,
          );
          if (waited === 'resumed') {
            attempted.delete(next.qualifiedId);
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
          if (waited === 'cancelled') {
            return { outcome: 'interrupted', summary: 'stopped while waiting for the usage limit' };
          }
        }
        await options.notify(usageLimitEvent(details, policy, allUsage));
        return {
          outcome: 'usage-limit',
          summary:
            policy === 'wait' ? 'implausible usage-limit reset time' : `${details.scope} usage limit hit (policy: stop)`,
        };
      }

      issuesProcessed += 1;

      if (result.fatal === null) {
        await options.notify({
          event: 'issue-completed',
          issue: { qualifiedId: next.qualifiedId, title: next.title },
          usage: result.usageEntries,
        });
        continue;
      }

      if (ESCALATION_OUTCOMES.has(result.outcome)) {
        const terminal = await handleEscalation(next, result.outcome, result.usageEntries);
        if (terminal) return terminal;
        continue;
      }

      if (result.outcome === 'interrupted') {
        return { outcome: 'interrupted', summary: `interrupted during ${next.qualifiedId}` };
      }
      return { outcome: result.outcome, summary: result.fatal.reason };
    }
  }

  /**
   * Worker pool over per-issue worktrees, mirroring `loop run`'s parallel
   * mode. Goal issue files live under `.loop/goals/` (outside every worktree),
   * so triage state is shared directly — only the code work merges back.
   * Post-merge verification uses each issue's *declared* command.
   */
  async function drainParallel(round: number): Promise<{ outcome: string; summary: string } | null> {
    type Claim = { issue: IssueRecord; entry: ReturnType<typeof resolveResumeStage> };

    const claimed = new Set<string>();
    let stopClaiming = false;
    let limitWait: LimitWait | null = null;
    let terminal: { outcome: string; summary: string } | null = null;
    const targetRef = getCurrentBranchName(workRoot) ?? 'HEAD';

    const setTerminal = (outcome: string, summary: string): void => {
      terminal ??= { outcome, summary };
      stopClaiming = true;
    };

    const claim = (): Claim | null => {
      if (stopClaiming || terminal || stopRequested()) return null;
      if (budgetCrossed()) {
        setTerminal('budget-reached', `reported spend crossed $${options.budgetUsd!.toFixed(2)}`);
        return null;
      }
      const next = pickNextIssue(discover(), labels, (issue) => !claimed.has(issue.qualifiedId));
      if (!next) return null;
      const preflight = runPreflight(config, next.project, workRoot, resolveProjectEnv(config, next.project));
      if (!preflight.ready) {
        printPreflightFailure(next.project, preflight);
        setTerminal(
          'preflight-failed',
          `environment not ready: ${preflight.probe?.message ?? 'readiness probe failed'}`,
        );
        stopClaiming = true;
        return null;
      }
      const entry = resolveResumeStage(next, labels);
      markInProgress(next, labels);
      claimed.add(next.qualifiedId);
      return { issue: next, entry };
    };

    const work = async (item: Claim): Promise<void> => {
      const { issue, entry } = item;
      const qid = issue.qualifiedId;

      let worktreeDir: string;
      let reattached = false;
      const created = createIssueWorktree(root, workRoot, qid);
      if (created.ok) {
        worktreeDir = created.worktree.dir;
      } else {
        const leftover = listLeftoverIssueWorktrees(root).find((entry_) => entry_.qualifiedId === qid);
        if (!leftover) {
          setIssueTriage(issue, 'agentFailed', labels);
          setTerminal('worktree-failed', `cannot isolate ${qid}: ${created.error}`);
          return;
        }
        console.log(`[goal ${paths.slug}] re-attaching to leftover worktree for ${qid} at ${leftover.dir}.`);
        worktreeDir = leftover.dir;
        reattached = true;
      }

      if (config.installCmd && !reattached) {
        const install = shell(config.installCmd, worktreeDir);
        if (!install.ok) {
          console.warn(`[loop] \`${config.installCmd}\` failed in ${worktreeDir}: ${install.output.trim().slice(0, 300)}`);
        }
      }

      const baseSha = getHeadSha(worktreeDir);
      console.log(`\n[goal ${paths.slug}] issue ${qid} — ${issue.title} (worker, ${path.basename(worktreeDir)})\n`);
      const result = await runIssuePipeline(issue, {
        entryStage: entry,
        iteration: round,
        root,
        cwd: worktreeDir,
        config,
        cliFlags,
        labels,
        verifyCmd: '',
        goal: goalContextFor(issue.id),
        liveOutput: false,
        deps,
      });
      allUsage.push(...result.usageEntries);

      let waitPolicyLimit = false;
      if (result.usageLimited) {
        const details = result.usageLimitDetails ?? { scope: 'session' as const, resetsAtMs: null };
        const policy = usageLimits[details.scope];
        if (policy === 'wait') {
          waitPolicyLimit = true;
          limitWait = mergeLimitWait(limitWait, details, clock.now());
          claimed.delete(qid);
          stopClaiming = true;
          console.error('[loop] usage limit hit — draining in-flight goal issues, then waiting for the reset.');
        } else {
          await options.notify(usageLimitEvent(details, policy, allUsage));
          setTerminal('usage-limit', `${details.scope} usage limit hit (policy: stop)`);
        }
      }

      // Merge back any commits (issue files live outside the worktree, so
      // only code moves here; triage was already written to the shared file).
      const endSha = getHeadSha(worktreeDir);
      const producedCommits = reattached || (baseSha !== null && endSha !== null && baseSha !== endSha);

      if (producedCommits) {
        const preMergeSha = getHeadSha(workRoot);
        const merge = mergeIssueWorktree(workRoot, targetRef, qid);
        if (merge.ok) {
          const rollingAdvanced = reattached || (baseSha !== null && preMergeSha !== null && preMergeSha !== baseSha);
          const declaredCmd = readDeclaredVerifyCmd(paths, issue.id);
          const postMergeVerify =
            rollingAdvanced && !waitPolicyLimit && result.fatal === null && declaredCmd
              ? await deps.runVerifyCommand(
                  declaredCmd,
                  workRoot,
                  path.join(roundDir(round), `post-merge-${issue.id}.verify.log`),
                  {
                    stageLabel: `${qid}-verify`,
                    heartbeatIntervalMs: config.heartbeatIntervalMs,
                  },
                )
              : null;
          if (postMergeVerify && !postMergeVerify.ok && preMergeSha !== null) {
            shell(`git reset --hard ${preMergeSha}`, workRoot);
            escalateIssueForSemanticConflict(issue, {
              branch: `loop/issue/${qid}`,
              worktreeDir,
              verifyCmd: declaredCmd ?? '',
              verifyLogPath: path.relative(root, path.join(roundDir(round), `post-merge-${issue.id}.verify.log`)),
              labels,
            });
            const escalated = await handleEscalation(issue, 'semantic-conflict', result.usageEntries);
            if (escalated) setTerminal(escalated.outcome, escalated.summary);
            console.error(
              `[goal ${paths.slug}] post-merge verify failed for ${qid} — merge rewound, worktree kept at ${worktreeDir}.`,
            );
            return;
          }
          const cleanup = cleanupIssueWorktree(root, qid);
          for (const message of cleanup.messages) console.warn(message);
          console.log(`[goal ${paths.slug}] merged ${qid} back into ${targetRef}.`);
        } else {
          escalateIssueForMergeConflict(issue, {
            branch: `loop/issue/${qid}`,
            worktreeDir,
            conflictingFiles: merge.conflictingFiles,
            labels,
          });
          const escalated = await handleEscalation(issue, 'merge-conflict', result.usageEntries);
          if (escalated) setTerminal(escalated.outcome, escalated.summary);
          console.error(
            `[goal ${paths.slug}] merge conflict for ${qid} — worktree/branch left at ${worktreeDir} (files: ${merge.conflictingFiles.join(', ') || 'unknown'}).`,
          );
          return;
        }
      } else {
        const cleanup = cleanupIssueWorktree(root, qid);
        for (const message of cleanup.messages) console.warn(message);
      }

      if (waitPolicyLimit) {
        console.log(`[goal ${paths.slug}] ${qid} paused on the usage limit — it will be re-claimed after the reset.`);
        return;
      }

      issuesProcessed += 1;

      if (result.fatal === null) {
        await options.notify({
          event: 'issue-completed',
          issue: { qualifiedId: qid, title: issue.title },
          usage: result.usageEntries,
        });
        console.log(`[goal ${paths.slug}] completed ${qid}.`);
        return;
      }

      if (ESCALATION_OUTCOMES.has(result.outcome)) {
        const escalated = await handleEscalation(issue, result.outcome, result.usageEntries);
        if (escalated) setTerminal(escalated.outcome, escalated.summary);
        return;
      }

      if (result.outcome === 'interrupted') {
        setTerminal('interrupted', `interrupted during ${qid}`);
        return;
      }
      setTerminal(result.outcome, result.fatal.reason);
    };

    // Pool → (optional limit wait) → pool again, mirroring `loop run`.
    for (;;) {
      await runWorkerPool(config.maxParallelRuns, claim, work);
      if (!limitWait || terminal || stopRequested()) break;
      const wait: LimitWait = limitWait;
      limitWait = null;
      const waited = await waitForLimitReset(wait, clock, stopRequested);
      if (waited === 'cancelled') return { outcome: 'interrupted', summary: 'stopped while waiting for the usage limit' };
      if (waited === 'gave-up') {
        await options.notify(usageLimitEvent({ scope: wait.scope, resetsAtMs: wait.resetsAtMs }, 'wait', allUsage));
        return { outcome: 'usage-limit', summary: 'implausible usage-limit reset time' };
      }
      stopClaiming = false;
    }

    if (terminal) return terminal;
    if (stopRequested()) return { outcome: 'interrupted', summary: 'stop requested mid-drain' };
    return null;
  }

  async function evaluateRound(round: number): Promise<
    | { ok: true; verdict: ReturnType<typeof parseGoalVerdict> }
    | { ok: false; outcome: string; summary: string }
  > {
    const dir = roundDir(round);
    mkdirSync(dir, { recursive: true });

    // Mechanical safety net first: re-run every declared command against the
    // merged state, so the judging session works from executed facts.
    const mechanicalResults: string[] = [];
    const seen = new Set<string>();
    let index = 0;
    for (const [issueId, cmd] of listDeclaredVerifyCmds(paths)) {
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      index += 1;
      const verify = await deps.runVerifyCommand(
        cmd,
        workRoot,
        path.join(dir, `mechanical-${index}.verify.log`),
        {
          stageLabel: `goal-${paths.slug}-mechanical-${index}`,
          heartbeatIntervalMs: config.heartbeatIntervalMs,
        },
      );
      mechanicalResults.push(`\`${cmd}\` (declared by ${issueId}) — ${verify.ok ? 'passed' : '**FAILED**'}`);
    }

    const evaluated = await runAuxSession(
      'evaluate',
      buildEvaluatePrompt({
        slug: paths.slug,
        goalDocPath: paths.goalDocPath,
        issuesProjectDir: paths.issuesProjectDir,
        verifyNotesPath: paths.verifyNotesPath,
        round,
        mechanicalResults,
      }),
      round,
    );
    if (!evaluated.ok) return evaluated;

    writeFileSync(path.join(paths.evaluationsDir, `round-${round}.md`), `${evaluated.text}\n`);

    try {
      return { ok: true, verdict: parseGoalVerdict(evaluated.text) };
    } catch (error) {
      return {
        ok: false,
        outcome: 'evaluate-failed',
        summary: `evaluation verdict unparseable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
