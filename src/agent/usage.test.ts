import { describe, expect, it } from 'vitest';

import type { AgentRunResult } from './run-agent.js';
import { agentStageUsageEntries } from './usage.js';

describe('agentStageUsageEntries', () => {
  it('records every provider attempt made within one stage', () => {
    const result = {
      agentCli: 'claude-code',
      model: 'opus-5',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 },
      costUsd: 0.25,
      attempts: [
        {
          agentCli: 'codex',
          model: 'gpt-5.6-sol',
          usage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: null,
        },
        {
          agentCli: 'claude-code',
          model: 'opus-5',
          usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 },
          costUsd: 0.25,
        },
      ],
    } as AgentRunResult;

    expect(agentStageUsageEntries('implement', result)).toEqual([
      {
        stage: 'implement',
        agentCli: 'codex',
        model: 'gpt-5.6-sol',
        inputTokens: 4,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        stage: 'implement',
        agentCli: 'claude-code',
        model: 'opus-5',
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        costUsd: 0.25,
      },
    ]);
  });

  it('keeps the single-session result shape backward compatible', () => {
    const result = {
      agentCli: 'cursor',
      model: 'auto',
      usage: { inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: null,
    } as AgentRunResult;

    expect(agentStageUsageEntries('review', result)).toEqual([
      {
        stage: 'review',
        agentCli: 'cursor',
        model: 'auto',
        inputTokens: 7,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
  });
});
