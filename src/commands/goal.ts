/**
 * `loop goal` — goal mode: no PRD, no curated backlog. Hand loop an outcome
 * and it loops plan → drain → evaluate rounds (src/goal/run-goal.ts) until a
 * fresh session judges the goal reached. `loop goal <slug>` resumes an
 * existing goal exactly where it stopped; `loop goals` lists them.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { GoalFlags } from '../cli/args.js';
import {
  createGoal,
  goalExists,
  goalPaths,
  listGoalIssueFiles,
  listGoals,
  loadGoalState,
  slugifyGoal,
} from '../goal/goal.js';
import { executeGoalLoop } from '../goal/run-goal.js';
import { failStop, registerShutdownHandlers } from '../interrupt/shutdown.js';
import { discoverIssues } from '../issues/discovery.js';
import { pickNextIssue } from '../issues/scheduling.js';
import { createNotifier } from '../notify/webhooks.js';
import { acquireInvocationLock } from '../shared/lock.js';
import { formatUsageTable } from '../usage/tokens.js';
import { startupCommand } from './startup.js';

const GOAL_STAGES = ['plan', 'implement', 'verifyFix', 'review', 'reviewFix', 'evaluate'] as const;

export async function goalCommand(flags: GoalFlags): Promise<never> {
  const shutdownHandle = registerShutdownHandlers();
  // Goal mode has no configured gate — every issue's session declares one.
  const startup = startupCommand({
    configOverrides: flags.config,
    stages: GOAL_STAGES,
    requireVerifyCmd: false,
  });
  const { root, config, labels, cliFlags, workRoot } = startup;

  // Resolve slug + text: an existing slug resumes; otherwise text (positional
  // or --file) creates a new goal under --name or a derived slug.
  let goalText: string | null = flags.text;
  if (flags.file) {
    if (!existsSync(flags.file)) failStop(`goal file not found: ${flags.file}`);
    goalText = readFileSync(flags.file, 'utf8');
  }

  let slug: string;
  if (flags.text && !flags.file && !flags.name && goalExists(root, flags.text)) {
    slug = flags.text; // exact slug match resumes
    goalText = null;
  } else {
    if (!goalText?.trim()) {
      failStop('no goal given', {
        details: [
          'Pass the goal text (`loop goal "Migrate every route to the gateway"`),',
          'a file (`loop goal --file ./goal.md`), or an existing slug to resume (`loop goals` lists them).',
        ],
      });
    }
    slug = flags.name ?? slugifyGoal(goalText);
  }

  const resuming = goalExists(root, slug);
  const paths = resuming ? goalPaths(root, slug) : createGoal(root, slug, goalText ?? '');
  if (resuming && goalText) {
    console.log(`[loop] goal "${slug}" already exists — resuming it (the stored goal.md stays authoritative).`);
  }
  const state = loadGoalState(paths);
  console.log(
    `[loop] goal "${slug}" — ${resuming ? `resuming at round ${state.round}` : 'created'}; folder: ${path.relative(root, paths.dir)}/`,
  );

  // Flag > goal.usageLimits > top-level usageLimits, per limit window.
  const usageLimits = {
    session: flags.onSessionLimit ?? config.goal.usageLimits.session ?? config.usageLimits.session,
    weekly: flags.onWeeklyLimit ?? config.goal.usageLimits.weekly ?? config.usageLimits.weekly,
  };

  const roundLimit = flags.roundLimit ?? config.goal.roundLimit;
  if (roundLimit === null && flags.budgetUsd === null) {
    console.warn(
      '[loop] warning: this goal run has no --round-limit and no --budget — nothing bounds it but the goal itself.',
    );
  }

  if (flags.dryRun) {
    const issues = discoverIssues(paths.issuesDir, workRoot);
    const runnable = pickNextIssue(issues, labels);
    console.log(`[dry-run] backlog: ${listGoalIssueFiles(paths).length} issue file(s); status: ${state.status}.`);
    console.log(
      runnable
        ? `[dry-run] next round would drain, starting with ${runnable.qualifiedId} — ${runnable.title}.`
        : '[dry-run] nothing runnable — the next round would start with a plan session.',
    );
    process.exit(0);
  }

  let releaseLock: () => void;
  try {
    releaseLock = acquireInvocationLock(root);
  } catch (error) {
    failStop('another loop invocation is running', {
      details: String(error instanceof Error ? error.message : error).split('\n'),
    });
  }
  process.once('exit', () => releaseLock());

  const notify = createNotifier(config.webhooks, { repoRoot: root, project: `goal/${slug}` });

  const result = await executeGoalLoop({
    root,
    workRoot,
    config,
    cliFlags,
    labels,
    paths,
    roundLimit,
    budgetUsd: flags.budgetUsd,
    usageLimits,
    supersedeLimit: flags.supersedeLimit ?? config.goal.supersedeLimit,
    liveOutput: !flags.quiet,
    notify,
    isStopRequested: () => shutdownHandle.isStopRequested() || shutdownHandle.isShuttingDown(),
  });

  if (result.issuesEscalated.length > 0) {
    console.log(
      `\n[loop] ${result.issuesEscalated.length} issue(s) escalated this run: ${result.issuesEscalated.join(', ')} — fix the cause, then \`loop run --unblock\` won't help here; edit the goal issues under ${path.relative(root, paths.issuesProjectDir)}/ or resume with \`loop goal ${slug}\` after resolving.`,
    );
  }
  if (result.usage.length > 0) {
    console.log(`\n[loop] token usage for this goal run:\n${formatUsageTable(result.usage)}`);
  }
  console.log(
    `\n[loop] goal "${slug}" stopped: ${result.outcome} after ${result.rounds} round(s) — ${result.summary || 'see above'}`,
  );

  if (result.outcome === 'reached') {
    console.log('[loop] the rolling branch holds the reviewed work — promote it to your real branch when ready.');
    process.exit(0);
  }
  if (result.outcome === 'round-limit' || result.outcome === 'budget-reached') process.exit(0);
  if (result.outcome === 'interrupted') process.exit(130);
  process.exit(1);
}

export function goalsCommand(root: string): never {
  const goals = listGoals(root);
  if (goals.length === 0) {
    console.log('No goals yet — start one with `loop goal "<outcome>"`.');
    process.exit(0);
  }
  for (const goal of goals) {
    console.log(
      `${goal.slug}  [${goal.status}]  round ${goal.round}, ${goal.issueCount} issue(s) — ${goal.headline}`,
    );
  }
  process.exit(0);
}
