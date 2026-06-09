/**
 * Shared startup sequence for `loop run` / `loop review`: load + validate
 * config, check the cwd-is-a-git-repo precondition, verify every distinct
 * agent binary resolved across the stages the command will run, and set up
 * the rolling worktree.
 */

import { spawnSync } from 'node:child_process';

import { collectStageEffortErrors } from '../config/effort.js';
import type { ConfigCliOverrides } from '../config/load-config.js';
import { loadConfig } from '../config/load-config.js';
import { resolveStageAgentCandidates, type StageCliFlags } from '../config/stage-settings.js';
import { resolveTriageLabels, type TriageLabels } from '../config/triage-labels.js';
import { STAGE_NAMES, type LoopConfig, type StageName } from '../config/types.js';
import { resolveAgentProvider } from '../agent/providers/index.js';
import type { AgentCli } from '../config/types.js';
import { isGitRepository } from '../git/status.js';
import { failStop } from '../interrupt/shutdown.js';
import { caution, detail } from '../logs/style.js';
import { startKeepAwake } from '../usage/limit-wait.js';
import { AGENT_AUTH_PROBE, probeAgentAuth } from './agent-auth-probe.js';
import { listLeftoverIssueWorktrees } from '../worktree/issue-worktree.js';
import { ensureRollingWorktree, type RollingWorktreeResult } from '../worktree/rolling-worktree.js';
import { resolveRoot } from '../shared/paths.js';
import { shell } from '../shared/shell.js';

export type CommandStartup = {
  /** Main repo root (process.cwd()) — `.loop/` bookkeeping lives here. */
  root: string;
  config: LoopConfig;
  labels: TriageLabels;
  /** The raw --agent-cli/--model whole-run overrides for per-stage resolution. */
  cliFlags: StageCliFlags;
  /** Where agent work happens: the rolling worktree, or root when disabled/unavailable. */
  workRoot: string;
  rolling: RollingWorktreeResult;
  /**
   * Resolved global verify command — failStop happened already when required
   * and unset. Empty string when the command opted out of the requirement
   * (goal mode: sessions declare their own commands).
   */
  verifyCmd: string;
};

/**
 * failStop unless every distinct agent binary resolved across `stages` is on
 * PATH, naming each missing binary and the stage(s) that need it.
 */
export function checkAgentBinaries(
  config: LoopConfig,
  cliFlags: StageCliFlags,
  stages: readonly StageName[] = STAGE_NAMES,
): void {
  const stagesByBinary = new Map<string, StageName[]>();
  for (const stage of stages) {
    for (const settings of resolveStageAgentCandidates(config, cliFlags, stage)) {
      const binary = resolveAgentProvider(settings.agentCli).binaryName;
      const existing = stagesByBinary.get(binary);
      if (existing && !existing.includes(stage)) existing.push(stage);
      else if (!existing) stagesByBinary.set(binary, [stage]);
    }
  }

  const missing = [...stagesByBinary.entries()].filter(
    ([binary]) => !shell(`command -v ${binary}`).ok,
  );
  if (missing.length > 0) {
    failStop('agent CLI binary missing', {
      details: missing.map(
        ([binary, binaryStages]) =>
          `\`${binary}\` not found on PATH — needed by stage(s): ${binaryStages.join(', ')}. Install it (or change agentCli/stages in loop.config.json).`,
      ),
    });
  }
}

const BINARY_PROBE_TIMEOUT_MS = 5000;

/**
 * Soft check beyond `command -v`: run `${binary} --version` with a short
 * timeout. A failure warns but does not block startup — auth/login problems
 * still surface when the agent subprocess runs.
 */
export function warnIfAgentBinariesNotRunnable(
  config: LoopConfig,
  cliFlags: StageCliFlags,
  stages: readonly StageName[] = STAGE_NAMES,
): void {
  const binaries = new Set<string>();
  for (const stage of stages) {
    for (const settings of resolveStageAgentCandidates(config, cliFlags, stage)) {
      binaries.add(resolveAgentProvider(settings.agentCli).binaryName);
    }
  }

  for (const binary of binaries) {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: BINARY_PROBE_TIMEOUT_MS,
    });
    if (result.status === 0) continue;
    const detail = (result.stderr || result.stdout || result.error?.message || 'no output').trim().slice(0, 200);
    console.warn(
      `[loop] warning: \`${binary} --version\` failed (${detail}) — binary is on PATH but may not be runnable or authenticated. Long runs may fail at agent spawn.`,
    );
  }
}

/**
 * Optional warn-only auth probe after binary + `--version` checks. Each CLI's
 * probe command is discovered from `--help` (see agent-auth-probe.ts). Failure
 * warns but never blocks startup — auth can be environment-specific.
 */
export function warnIfAgentBinariesNotAuthenticated(
  config: LoopConfig,
  cliFlags: StageCliFlags,
  stages: readonly StageName[] = STAGE_NAMES,
): void {
  const agents = new Set<AgentCli>();
  for (const stage of stages) {
    for (const settings of resolveStageAgentCandidates(config, cliFlags, stage)) {
      agents.add(settings.agentCli);
    }
  }

  for (const agentCli of agents) {
    const spec = AGENT_AUTH_PROBE[agentCli];
    if (!spec) continue;

    const binary = resolveAgentProvider(agentCli).binaryName;
    const outcome = probeAgentAuth(binary, spec);
    if (outcome.ok === true || outcome.ok === 'skipped') continue;

    const cmd = `${binary} ${spec.args.join(' ')}`;
    console.warn(
      `[loop] warning: \`${cmd}\` suggests the CLI is not authenticated (${outcome.reason}) — long runs may fail at agent spawn. Run the CLI's login flow if needed.`,
    );
  }
}

export function startupCommand(options: {
  configOverrides: ConfigCliOverrides;
  /** Stages this command will spawn — drives the binary availability check. */
  stages: readonly StageName[];
  /** Goal mode passes false: there is no configured gate — sessions declare their own. */
  requireVerifyCmd?: boolean;
}): CommandStartup {
  const root = resolveRoot();

  let config: LoopConfig;
  try {
    config = loadConfig(root, { cli: options.configOverrides });
  } catch (error) {
    failStop('invalid configuration', {
      details: String(error instanceof Error ? error.message : error).split('\n'),
    });
  }
  const labels = resolveTriageLabels(config);
  const cliFlags: StageCliFlags = {
    agentCli: options.configOverrides.agentCli,
    model: options.configOverrides.model,
    effort: options.configOverrides.effort,
  };

  const effortErrors = collectStageEffortErrors(config, cliFlags, options.stages);
  if (effortErrors.length > 0) {
    failStop('invalid effort configuration', { details: effortErrors });
  }

  if (!isGitRepository(root)) {
    failStop('cwd must be a git repository', {
      details: [`loop operates on the repository at the current working directory (${root}).`],
    });
  }

  // A long unattended run that sleeps mid-issue is as lost as one that sleeps
  // through a usage-limit wait, so the inhibitor covers the whole invocation.
  // It is tied to this process id, so a crash releases it.
  if (config.keepAwake && process.platform === 'darwin') {
    const release = startKeepAwake();
    process.once('exit', () => release());
    console.log(
      `[loop] ${caution('keeping the machine awake while loop runs')} ${detail('(--no-caffeinate to disable)')}`,
    );
  }

  if (!config.verifyCmd && (options.requireVerifyCmd ?? true)) {
    failStop('no verify command configured', {
      details: [
        'Loop needs an external verify command (typecheck/tests) to confirm agent work.',
        'Set `verifyCmd` in loop.config.json, pass --verify-cmd, or set LOOP_VERIFY_CMD.',
      ],
    });
  }

  checkAgentBinaries(config, cliFlags, options.stages);
  warnIfAgentBinariesNotRunnable(config, cliFlags, options.stages);
  warnIfAgentBinariesNotAuthenticated(config, cliFlags, options.stages);

  const rolling = ensureRollingWorktree(root, {
    disabled: !config.worktreeEnabled,
    installCmd: config.installCmd,
    dependencyFiles: config.dependencyFiles,
  });
  for (const message of rolling.messages) console.log(message);

  const leftovers = listLeftoverIssueWorktrees(root);
  if (leftovers.length > 0) {
    console.warn(
      `[loop] ${leftovers.length} leftover per-issue worktree(s) from a previous run (not auto-resumed or deleted):`,
    );
    for (const leftover of leftovers) {
      console.warn(`  - ${leftover.qualifiedId}: ${leftover.dir} (branch ${leftover.branch})`);
    }
  }

  return {
    root,
    config,
    labels,
    cliFlags,
    workRoot: rolling.workRoot,
    rolling,
    verifyCmd: config.verifyCmd ?? '',
  };
}
