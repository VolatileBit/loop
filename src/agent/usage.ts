import type { StageUsage } from '../usage/tokens.js';
import type { AgentAttemptTelemetry } from './run-agent.js';

export type AgentUsageSource = AgentAttemptTelemetry & {
  attempts?: readonly AgentAttemptTelemetry[];
};

/** Converts every real CLI attempt in one logical stage into usage-table rows. */
export function agentStageUsageEntries(
  stage: string,
  result: AgentUsageSource,
): StageUsage[] {
  const attempts = result.attempts ?? [result];
  return attempts.flatMap((attempt) => {
    if (!attempt.usage) return [];
    return [
      {
        stage,
        agentCli: attempt.agentCli,
        model: attempt.model,
        elapsedMs: attempt.elapsedMs,
        ...(attempt.peakContextTokens !== null ? { peakContextTokens: attempt.peakContextTokens } : {}),
        ...attempt.usage,
        ...(attempt.costUsd !== null ? { costUsd: attempt.costUsd } : {}),
      },
    ];
  });
}
