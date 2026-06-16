/**
 * `loop review [--fix]` — batch review of explicitly targeted issues.
 * Serial mode preserves today's fail-fast behavior (the first fatal outcome
 * stops the batch via failStop). With maxParallelRuns > 1 the targets are
 * processed by the shared worker pool: `--fix` isolates each target in a
 * per-issue worktree that merges back (it makes commits); review-only runs
 * concurrently against the shared work root (read-only premise).
 */

import { getHeadSha } from '../git/status.js';
import { failStop, registerShutdownHandlers } from '../interrupt/shutdown.js';
import { discoverIssues } from '../issues/discovery.js';
import { escalateIssueForMergeConflict } from '../issues/escalation.js';
import type { IssueRecord } from '../issues/types.js';
import { loadState, saveState } from '../logs/state.js';
import {
  resolveReviewTargets,
  reviewIssueInBatch,
  type BatchReviewOptions,
  type BatchReviewOutcome,
} from '../review/batch.js';
import { buildReviewPromptForIssue, warnIfReviewDiffLimited } from '../review/run-review-session.js';
import { acquireInvocationLock } from '../shared/lock.js';
import { shell } from '../shared/shell.js';
import {
  cleanupIssueWorktree,
  createIssueWorktree,
  mergeIssueWorktree,
} from '../worktree/issue-worktree.js';
import { getCurrentBranchName } from '../worktree/rolling-worktree.js';
import { runWorkerPool } from '../worktree/worker-pool.js';
import type { ReviewFlags } from '../cli/args.js';
import { startupCommand } from './startup.js';

export async function reviewCommand(flags: ReviewFlags): Promise<never> {
  const shutdownHandle = registerShutdownHandlers();

  const startup = startupCommand({
    configOverrides: flags.config,
    stages: flags.fix ? ['review', 'reviewFix', 'verifyFix'] : ['review'],
  });
  const { root, config, labels, cliFlags, workRoot, verifyCmd } = startup;

  if (!flags.until && flags.ids.length === 0 && !flags.file) {
    failStop('review mode requires a target', {
      details: ['Pass --until, --ids, or --file.'],
    });
  }

  let issues: IssueRecord[];
  try {
    issues = discoverIssues(config.issuesDir, workRoot);
  } catch (error) {
    failStop('issue discovery failed', {
      details: String(error instanceof Error ? error.message : error).split('\n'),
    });
  }

  let targets: IssueRecord[];
  try {
    targets = resolveReviewTargets(issues, {
      ids: flags.ids,
      until: flags.until,
      file: flags.file,
    });
  } catch (error) {
    failStop('failed to resolve review targets', {
      details: String(error instanceof Error ? error.message : error).split('\n'),
    });
  }

  if (targets.length === 0) {
    failStop('no review targets specified', {
      details: ['Use --until, --ids, or --file.'],
    });
  }

  warnIfReviewDiffLimited(workRoot);
  const state = loadState(root);
  console.log(`Reviewing ${targets.length} issue(s)${flags.fix ? ' with fix loop' : ''}…`);

  if (flags.dryRun) {
    for (const issue of targets) {
      console.log(`\n=== Loop review: ${issue.qualifiedId} ===\n`);
      console.log(buildReviewPromptForIssue(issue, { config, cwd: workRoot, root, round: 1 }));
    }
    process.exit(0);
  }

  // Reviews run in (and --fix commits to) the shared work root — one mutating
  // invocation per repo at a time, same as `loop run`.
  let releaseLock: () => void;
  try {
    releaseLock = acquireInvocationLock(root);
  } catch (error) {
    failStop('another loop invocation is running', {
      details: String(error instanceof Error ? error.message : error).split('\n'),
    });
  }
  process.once('exit', () => releaseLock());

  const batchOptions: BatchReviewOptions = {
    config,
    cliFlags,
    labels,
    root,
    cwd: workRoot,
    withFix: flags.fix,
    verifyCmd,
    liveOutput: !flags.quiet && config.maxParallelRuns === 1,
    // Issue-independent prompt context (PRD resolution is per-issue and stays
    // out of batch mode); verifyCmd lets fix prompts state the in-session-proof deal.
    promptContext: {
      reviewSkill: config.reviewSkill,
      tddSkill: config.tddSkill,
      labels: { inProgress: labels.inProgress, done: labels.done },
      verifyCmd,
    },
  };

  const blockingRemaining: string[] = [];
  const fatalFailures: string[] = [];

  const handleOutcome = (issue: IssueRecord, outcome: BatchReviewOutcome): void => {
    if (outcome.status === 'blocking' || outcome.status === 'escalated') {
      blockingRemaining.push(issue.qualifiedId);
    } else if (outcome.status === 'fatal') {
      fatalFailures.push(`${issue.qualifiedId}: ${outcome.reason}`);
    }
  };

  if (config.maxParallelRuns === 1) {
    for (const issue of targets) {
      if (shutdownHandle.isStopRequested() || shutdownHandle.isShuttingDown()) {
        saveState(root, { ...state, stoppedReason: 'stopped-by-user' });
        process.exit(0);
      }

      console.log(`\n=== Loop review: ${issue.qualifiedId} ===\n`);
      const outcome = await reviewIssueInBatch(issue, batchOptions);
      if (outcome.status === 'fatal') {
        saveState(root, { ...state, stoppedReason: outcome.code === 2 ? 'usage-limit' : 'review-failed' });
        failStop(outcome.reason, {
          ...(outcome.code !== undefined ? { code: outcome.code } : {}),
          ...(outcome.details ? { details: outcome.details } : {}),
        });
      }
      handleOutcome(issue, outcome);
    }
  } else {
    await runReviewPool();
  }

  if (fatalFailures.length > 0) {
    failStop(`${fatalFailures.length} review target(s) failed`, { details: fatalFailures });
  }

  if (blockingRemaining.length > 0) {
    failStop(`human intervention required for: ${blockingRemaining.join(', ')}`, {
      details: [
        `Issues with blocking findings. See issue \`## Loop escalation\` sections and .loop/runs/*-review/.`,
      ],
    });
  }

  console.log('\nAll review targets satisfied (pass or nits-only).');
  process.exit(0);

  async function runReviewPool(): Promise<void> {
    const queue = [...targets];
    let stopClaiming = false;

    const claim = (): IssueRecord | null => {
      if (stopClaiming || shutdownHandle.isStopRequested() || shutdownHandle.isShuttingDown()) return null;
      return queue.shift() ?? null;
    };

    const work = async (issue: IssueRecord): Promise<void> => {
      console.log(`\n=== Loop review: ${issue.qualifiedId} ===\n`);

      if (!flags.fix) {
        const outcome = await reviewIssueInBatch(issue, batchOptions);
        if (outcome.status === 'fatal' && outcome.code === 2) stopClaiming = true;
        handleOutcome(issue, outcome);
        return;
      }

      // Fix mode makes commits — isolate in a per-issue worktree, merge back.
      const qid = issue.qualifiedId;
      const created = createIssueWorktree(root, workRoot, qid);
      if (!created.ok) {
        fatalFailures.push(`${qid}: worktree creation failed — ${created.error}`);
        return;
      }
      const worktreeDir = created.worktree.dir;

      if (config.installCmd) {
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
        fatalFailures.push(`${qid}: issue file not found in its worktree ${worktreeDir}`);
        cleanupIssueWorktree(root, qid);
        return;
      }

      const outcome = await reviewIssueInBatch(worktreeIssue, {
        ...batchOptions,
        cwd: worktreeDir,
        liveOutput: false,
      });
      if (outcome.status === 'fatal' && outcome.code === 2) stopClaiming = true;
      handleOutcome(issue, outcome);

      const endSha = getHeadSha(worktreeDir);
      if (baseSha !== null && endSha !== null && baseSha !== endSha) {
        const targetRef = startup.rolling.rollingBranch ?? getCurrentBranchName(workRoot) ?? 'HEAD';
        const merge = mergeIssueWorktree(workRoot, targetRef, qid);
        if (merge.ok) {
          const cleanup = cleanupIssueWorktree(root, qid);
          for (const message of cleanup.messages) console.warn(message);
          console.log(`[loop] merged ${qid} back into ${targetRef}.`);
        } else {
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
          }
          fatalFailures.push(`${qid}: merge conflict (worktree kept at ${worktreeDir})`);
        }
      } else {
        const cleanup = cleanupIssueWorktree(root, qid);
        for (const message of cleanup.messages) console.warn(message);
      }
    };

    await runWorkerPool(config.maxParallelRuns, claim, work);
  }
}
