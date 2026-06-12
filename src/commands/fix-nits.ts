/**
 * `loop fix-nits` — one agent session over the whole nits backlog
 * (`.loop/nits.md`): fix or dismiss every section, verify, commit. The batch
 * is atomic from the runner's side: the session edits the backlog file as it
 * goes, but any failure (agent crash, unparseable decisions, failed verify)
 * restores the pre-session snapshot — findings whose fixes never landed are
 * never silently dropped.
 *
 * The core batch is exposed as `executeFixNitsBatch` so `loop polish` can run
 * it as its first phase under a single lock/invocation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { extractAgentResultText, runAgent } from '../agent/run-agent.js';
import { agentStageUsageEntries } from '../agent/usage.js';
import type { FixNitsFlags } from '../cli/args.js';
import type { StageCliFlags } from '../config/stage-settings.js';
import type { LoopConfig } from '../config/types.js';
import { logLoopCommit } from '../git/log-commit.js';
import { listDirtyPaths } from '../git/status.js';
import { failStop, registerShutdownHandlers } from '../interrupt/shutdown.js';
import { formatRunTimestamp } from '../logs/run-context.js';
import { createNotifier, type Notifier } from '../notify/webhooks.js';
import { hasNitsEntries, parseNitsDecisions, type NitsDecision } from '../review/nits.js';
import { buildFixNitsPrompt } from '../review/prompts.js';
import { acquireInvocationLock } from '../shared/lock.js';
import { nitsPath, runsDir } from '../shared/paths.js';
import { recordSkippedVerify, verifySatisfiedInSession, runVerifyCommand } from '../verify/run-verify.js';
import { formatUsageTable, type StageUsage } from '../usage/tokens.js';
import { startupCommand } from './startup.js';

export type FixNitsBatchResult =
  | { outcome: 'nothing' }
  | { outcome: 'done'; fixed: number; dismissed: number; usage: StageUsage[]; runDir: string }
  | { outcome: 'failed'; reason: string; details: string[]; usage: StageUsage[] };

export type FixNitsBatchOptions = {
  root: string;
  config: LoopConfig;
  cliFlags: StageCliFlags;
  workRoot: string;
  verifyCmd: string;
  liveOutput: boolean;
  notify: Notifier;
};

/** The core nits batch: no lock, no exits — callers own invocation concerns. */
export async function executeFixNitsBatch(options: FixNitsBatchOptions): Promise<FixNitsBatchResult> {
  const { root, config, cliFlags, workRoot, verifyCmd } = options;
  const preExistingDirtyPaths = listDirtyPaths(workRoot);

  const backlogPath = nitsPath(root);
  if (!existsSync(backlogPath)) {
    console.log('[loop] no nits backlog (.loop/nits.md does not exist) — nothing to fix.');
    return { outcome: 'nothing' };
  }
  const snapshot = readFileSync(backlogPath, 'utf8');
  if (!hasNitsEntries(snapshot)) {
    console.log('[loop] nits backlog has no entries — nothing to fix.');
    return { outcome: 'nothing' };
  }

  const prompt = buildFixNitsPrompt({ nitsPath: backlogPath, verifyCmd });
  const runDir = path.join(runsDir(root), 'nits', `${formatRunTimestamp(new Date())}-fix-nits`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'prompt.md'), `${prompt}\n`);

  const usageEntries: StageUsage[] = [];

  const fail = async (reason: string, details: string[] = []): Promise<FixNitsBatchResult> => {
    // Discard the session's own backlog edits — the fixes they correspond to never landed.
    writeFileSync(backlogPath, snapshot);
    await options.notify({ event: 'fix-nits-completed', outcome: 'failed', usage: usageEntries });
    return {
      outcome: 'failed',
      reason,
      details: [...details, `Run dir: ${path.relative(root, runDir)}/`, 'nits.md restored to its pre-session state.'],
      usage: usageEntries,
    };
  };

  console.log(`[loop] fix-nits session over ${path.relative(root, backlogPath)} → ${path.relative(root, runDir)}/`);
  const agentResult = await runAgent(prompt, {
    config,
    cliFlags,
    stage: 'reviewFix',
    cwd: workRoot,
    logPath: path.join(runDir, 'fix-nits.stream.log'),
    stageLabel: 'fix-nits',
    liveOutput: options.liveOutput,
  });

  usageEntries.push(...agentStageUsageEntries('fix-nits', agentResult));

  if (agentResult.stuckReason === 'interrupted') return fail('fix-nits session was interrupted');
  if (agentResult.usageLimited) return fail('usage limit hit during the fix-nits session');
  if (agentResult.stuckReason) return fail(`fix-nits session got stuck (${agentResult.stuckReason})`);
  if (!agentResult.ok) return fail('fix-nits session failed');

  let decisions: NitsDecision[];
  try {
    decisions = parseNitsDecisions(extractAgentResultText(agentResult));
  } catch (error) {
    return fail('fix-nits decisions unparseable', [String(error instanceof Error ? error.message : error)]);
  }

  // The session's own stream may already have proven the verify gate.
  const verifyLogPath = path.join(runDir, 'verify.log');
  const verify = verifySatisfiedInSession(agentResult.provenCommands, verifyCmd)
    ? recordSkippedVerify(verifyCmd, verifyLogPath)
    : await runVerifyCommand(verifyCmd, workRoot, verifyLogPath, {
        stageLabel: 'fix-nits-verify',
        heartbeatIntervalMs: config.heartbeatIntervalMs,
      });
  if (!verify.ok) {
    return fail('verify failed after the fix-nits session', [`Verify log: ${path.relative(root, verifyLogPath)}`]);
  }

  // Commit anything the session left uncommitted (same fallback as pipeline stages).
  logLoopCommit(null, 'nits', 'fix-nits', {
    cwd: workRoot,
    excludePaths: config.commitExcludePaths,
    preservePaths: preExistingDirtyPaths,
    runDir,
  });

  const fixed = decisions.filter((decision) => decision.action === 'fixed').length;
  const dismissed = decisions.filter((decision) => decision.action === 'dismissed').length;
  writeFileSync(path.join(runDir, 'decisions.json'), `${JSON.stringify(decisions, null, 2)}\n`);

  await options.notify({ event: 'fix-nits-completed', outcome: 'done', fixed, dismissed, usage: usageEntries });
  console.log(
    `\n[loop] fix-nits complete — ${fixed} fixed, ${dismissed} dismissed. Decisions: ${path.relative(root, runDir)}/decisions.json`,
  );
  return { outcome: 'done', fixed, dismissed, usage: usageEntries, runDir };
}

export async function fixNitsCommand(flags: FixNitsFlags): Promise<never> {
  registerShutdownHandlers({});
  // The fix session runs on the reviewFix stage's provider/model settings.
  const startup = startupCommand({ configOverrides: flags.config, stages: ['reviewFix'] });
  const { root, config, cliFlags, workRoot, verifyCmd } = startup;

  if (flags.dryRun) {
    const backlogPath = nitsPath(root);
    if (!existsSync(backlogPath) || !hasNitsEntries(readFileSync(backlogPath, 'utf8'))) {
      console.log('[loop] nits backlog is empty — nothing to do.');
      process.exit(0);
    }
    console.log(buildFixNitsPrompt({ nitsPath: backlogPath, verifyCmd }));
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

  const notify = createNotifier(config.webhooks, { repoRoot: root, project: null });
  const result = await executeFixNitsBatch({
    root,
    config,
    cliFlags,
    workRoot,
    verifyCmd,
    liveOutput: !flags.quiet,
    notify,
  });

  if (result.outcome === 'failed') {
    if (result.usage.length > 0) console.log(`\n[loop] token usage:\n${formatUsageTable(result.usage)}`);
    failStop(result.reason, { details: result.details });
  }
  if (result.outcome === 'done' && result.usage.length > 0) {
    console.log(`\n[loop] token usage:\n${formatUsageTable(result.usage)}`);
  }
  process.exit(0);
}
