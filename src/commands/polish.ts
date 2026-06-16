/**
 * `loop polish <project>` — the wrap-up pass for a project, two sessions under
 * one invocation:
 *
 * 1. **fix-nits** — the existing atomic batch over `.loop/nits.md` (skipped
 *    when the backlog is empty).
 * 2. **distill** — promote the project's shared notes (and archived handoffs)
 *    into the repo's tracked `CONTEXT.md` files, shrink the notes back down,
 *    verify, commit.
 *
 * A failed nits phase stops the polish before distilling — never distill on a
 * tree the nits pass just broke.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runAgent } from '../agent/run-agent.js';
import { agentStageUsageEntries } from '../agent/usage.js';
import type { PolishFlags } from '../cli/args.js';
import { ensureProjectNotes } from '../handoff/project-notes.js';
import { logLoopCommit } from '../git/log-commit.js';
import { listDirtyPaths } from '../git/status.js';
import { failStop, registerShutdownHandlers } from '../interrupt/shutdown.js';
import { discoverIssues } from '../issues/discovery.js';
import { listProjects } from '../issues/project.js';
import { formatRunTimestamp } from '../logs/run-context.js';
import { createNotifier } from '../notify/webhooks.js';
import { buildDistillPrompt } from '../review/prompts.js';
import { acquireInvocationLock } from '../shared/lock.js';
import { runsDir } from '../shared/paths.js';
import { recordSkippedVerify, verifySatisfiedInSession, runVerifyCommand } from '../verify/run-verify.js';
import { formatUsageTable, type StageUsage } from '../usage/tokens.js';
import { executeFixNitsBatch } from './fix-nits.js';
import { startupCommand } from './startup.js';

export async function polishCommand(flags: PolishFlags): Promise<never> {
  registerShutdownHandlers({});
  // Nits run on reviewFix settings; the distill doc pass on implement settings.
  const startup = startupCommand({ configOverrides: flags.config, stages: ['reviewFix', 'implement'] });
  const { root, config, cliFlags, workRoot, verifyCmd } = startup;

  if (!flags.project) {
    failStop('loop polish needs a project', {
      details: ['Usage: loop polish <project>', 'Projects are the folders under issuesDir.'],
    });
  }
  const project = flags.project;

  const known = listProjects(discoverIssues(config.issuesDir, workRoot));
  if (!known.some((name) => name.toLowerCase() === project.toLowerCase())) {
    failStop(`unknown project "${project}"`, {
      details: [known.length > 0 ? `Known projects: ${known.join(', ')}` : `No projects found under ${config.issuesDir}/.`],
    });
  }

  const runArchiveDir = path.join(runsDir(root), project);
  const distillPrompt = (notesPath: string): string =>
    buildDistillPrompt({ project, notesPath, runArchiveDir, verifyCmd });

  if (flags.dryRun) {
    console.log('[dry-run] polish phase 1: fix-nits batch over .loop/nits.md (skipped when empty).');
    console.log('[dry-run] polish phase 2: distill session prompt:\n');
    console.log(distillPrompt(ensureProjectNotes(root, project)));
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

  const notify = createNotifier(config.webhooks, { repoRoot: root, project });
  const allUsage: StageUsage[] = [];

  const finishFail = async (outcome: string, reason: string, details: string[]): Promise<never> => {
    await notify({ event: 'polish-completed', polishedProject: project, outcome, usage: allUsage });
    if (allUsage.length > 0) console.log(`\n[loop] token usage:\n${formatUsageTable(allUsage)}`);
    failStop(reason, { details });
  };

  // --- phase 1: nits -------------------------------------------------------

  console.log(`\n[loop] polish ${project} — phase 1/2: nits backlog.\n`);
  const nits = await executeFixNitsBatch({
    root,
    config,
    cliFlags,
    workRoot,
    verifyCmd,
    liveOutput: !flags.quiet,
    notify,
  });
  if (nits.outcome === 'failed') {
    allUsage.push(...nits.usage);
    return finishFail('nits-failed', `polish stopped in the nits phase: ${nits.reason}`, [
      ...nits.details,
      'The distill phase did not run.',
    ]);
  }
  if (nits.outcome === 'done') allUsage.push(...nits.usage);

  // --- phase 2: distill ----------------------------------------------------

  console.log(`\n[loop] polish ${project} — phase 2/2: distilling notes into CONTEXT.md.\n`);
  const preExistingDirtyPaths = listDirtyPaths(workRoot);
  const notesPath = ensureProjectNotes(root, project);
  const prompt = distillPrompt(notesPath);
  const runDir = path.join(runsDir(root), project, `${formatRunTimestamp(new Date())}-polish-distill`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'prompt.md'), `${prompt}\n`);

  const agentResult = await runAgent(prompt, {
    config,
    cliFlags,
    stage: 'implement',
    cwd: workRoot,
    logPath: path.join(runDir, 'distill.stream.log'),
    stageLabel: `${project}-distill`,
    liveOutput: !flags.quiet,
  });
  allUsage.push(...agentStageUsageEntries('distill', agentResult));

  if (agentResult.stuckReason === 'interrupted') {
    return finishFail('distill-failed', 'distill session was interrupted', [`Run dir: ${path.relative(root, runDir)}/`]);
  }
  if (agentResult.usageLimited) {
    return finishFail('distill-failed', 'usage limit hit during the distill session', [`Run dir: ${path.relative(root, runDir)}/`]);
  }
  if (agentResult.stuckReason || !agentResult.ok) {
    return finishFail('distill-failed', `distill session ${agentResult.stuckReason ? `got stuck (${agentResult.stuckReason})` : 'failed'}`, [
      `Agent log: ${path.relative(root, path.join(runDir, 'distill.stream.log'))}`,
    ]);
  }

  const verifyLogPath = path.join(runDir, 'verify.log');
  const verify = verifySatisfiedInSession(agentResult.provenCommands, verifyCmd)
    ? recordSkippedVerify(verifyCmd, verifyLogPath)
    : await runVerifyCommand(verifyCmd, workRoot, verifyLogPath, {
        stageLabel: `${project}-distill-verify`,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
      });
  if (!verify.ok) {
    return finishFail('distill-failed', 'verify failed after the distill session', [
      `Verify log: ${path.relative(root, verifyLogPath)}`,
      'The working tree holds the unverified distill edits for inspection.',
    ]);
  }

  logLoopCommit(null, project, 'polish', {
    cwd: workRoot,
    excludePaths: config.commitExcludePaths,
    preservePaths: preExistingDirtyPaths,
    runDir,
    suggestion: { type: 'doc', summary: `distill ${project} notes into CONTEXT.md` },
  });

  await notify({ event: 'polish-completed', polishedProject: project, outcome: 'done', usage: allUsage });
  console.log(`\n[loop] polish ${project} complete — nits ${nits.outcome === 'done' ? `cleared (${nits.fixed} fixed, ${nits.dismissed} dismissed)` : 'backlog was empty'}, notes distilled.`);
  if (allUsage.length > 0) console.log(`\n[loop] token usage:\n${formatUsageTable(allUsage)}`);
  process.exit(0);
}
