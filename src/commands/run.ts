
import { resolveStageAgentCandidates, type StageCliFlags } from '../config/stage-settings.js';
import { STAGE_NAMES, type AgentCli, type LoopConfig } from '../config/types.js';
import { formatUsageTable, type StageUsage } from '../usage/tokens.js';

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
