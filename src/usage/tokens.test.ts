import { describe, expect, it } from 'vitest';

import {
  aggregateStageUsage,
  contextWindowEstimate,
  formatCompactNumber,
  formatElapsed,
  formatUsageTable,
  stageContextTokens,
  parseUsageFromResultEvent,
  totalTokens,
  type StageUsage,
} from './tokens.js';

describe('formatCompactNumber', () => {
  it('keeps small values as integers', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(283)).toBe('283');
    expect(formatCompactNumber(999)).toBe('999');
  });

  it('formats thousands and millions with compact suffixes', () => {
    expect(formatCompactNumber(1000)).toBe('1K');
    expect(formatCompactNumber(90300)).toBe('90.3K');
    expect(formatCompactNumber(3_450_000)).toBe('3.45M');
    expect(formatCompactNumber(14_420_491)).toBe('14.4M');
    expect(formatCompactNumber(9_910_675)).toBe('9.91M');
  });

  it('strips trailing zeros after the decimal', () => {
    expect(formatCompactNumber(12_000)).toBe('12K');
    expect(formatCompactNumber(1_500_000)).toBe('1.5M');
  });
});

describe('parseUsageFromResultEvent', () => {
  it('extracts usage fields from a result event', () => {
    const usage = parseUsageFromResultEvent({
      type: 'result',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 10 },
    });
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 10 });
  });

  it('returns null when there is no usage field', () => {
    expect(parseUsageFromResultEvent({ type: 'result' })).toBeNull();
    expect(parseUsageFromResultEvent(null)).toBeNull();
  });

  it('defaults missing numeric fields to 0', () => {
    const usage = parseUsageFromResultEvent({ usage: { inputTokens: 10 } });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe('totalTokens / contextWindowEstimate', () => {
  it('sums all four counters for totalTokens', () => {
    expect(totalTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBe(10);
  });

  it('excludes output tokens from the context window estimate', () => {
    expect(contextWindowEstimate({ inputTokens: 1, outputTokens: 100, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBe(
      8,
    );
  });
});

describe('aggregateStageUsage', () => {
  const entries: StageUsage[] = [
    { stage: 'implement', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0 },
    { stage: 'review-round-1', inputTokens: 200, outputTokens: 50, cacheReadTokens: 9000, cacheWriteTokens: 0 },
  ];

  it('sums totals across stages and finds the peak context-window stage', () => {
    const aggregate = aggregateStageUsage(entries);
    expect(aggregate.totals).toEqual({ inputTokens: 1200, outputTokens: 150, cacheReadTokens: 9500, cacheWriteTokens: 0 });
    expect(aggregate.totalTokens).toBe(10850);
    expect(aggregate.peakStage).toBe('review-round-1');
    expect(aggregate.peakContextWindow).toBe(9200);
  });

  it('handles an empty entry list', () => {
    const aggregate = aggregateStageUsage([]);
    expect(aggregate.totalTokens).toBe(0);
    expect(aggregate.peakStage).toBeNull();
  });
});

describe('formatUsageTable', () => {
  it('totals the peak-ctx column as a high-water mark, not a sum', () => {
    const table = formatUsageTable([
      {
        stage: 'review-round-1',
        inputTokens: 1_050,
        outputTokens: 55_900,
        cacheReadTokens: 9_560_000,
        cacheWriteTokens: 195_000,
        peakContextTokens: 202_000,
      },
      {
        stage: 'review-fix-1',
        inputTokens: 178,
        outputTokens: 54_500,
        cacheReadTokens: 8_310_000,
        cacheWriteTokens: 134_000,
        peakContextTokens: 141_000,
      },
    ]);

    const total = table.split('\n').find((line) => line.startsWith('TOTAL'))!;
    // Every other cell in that column is a context window. Summing them reports
    // a number no session ever held, and contradicts the peak line below.
    expect(total).toContain('202K');
    expect(total).not.toContain('18.3M');
    expect(table).toMatch(/Peak context: 202K tokens — stage "review-round-1"/);
  });

  it('renders a table with a TOTAL row and peak line', () => {
    const table = formatUsageTable([
      { stage: 'implement', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(table).toContain('implement');
    expect(table).toContain('TOTAL');
    expect(table).toContain('Peak context');
    expect(table).toContain('1K');
    expect(table).toMatch(/Peak context \(est\.\): 1K tokens/);
  });

  it('uses compact suffixes for large usage numbers', () => {
    const table = formatUsageTable([
      {
        stage: 'implement',
        inputTokens: 283,
        outputTokens: 29_699,
        cacheReadTokens: 9_810_104,
        cacheWriteTokens: 100_288,
      },
    ]);
    expect(table).toContain('283');
    expect(table).toContain('29.7K');
    expect(table).toContain('9.81M');
    expect(table).toContain('100K');
  });

  it('includes an agent/model column populated per stage', () => {
    const table = formatUsageTable([
      {
        stage: 'implement',
        agentCli: 'claude-code',
        model: 'sonnet-5',
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      { stage: 'review-round-1', agentCli: 'codex', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(table).toContain('agent/model');
    expect(table).toContain('claude-code/sonnet-5');
    expect(table).toContain('codex');
  });

  it('leaves the agent/model cell blank when neither field is recorded', () => {
    const table = formatUsageTable([
      { stage: 'implement', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    const row = table.split('\n').find((line) => line.startsWith('implement'));
    expect(row).toBeDefined();
    expect(row).not.toContain('undefined');
  });

  it('handles no usage data', () => {
    expect(formatUsageTable([])).toContain('no usage data');
  });
});

describe('elapsed time per stage', () => {
  const withElapsed: StageUsage[] = [
    {
      stage: 'implement',
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      elapsedMs: 134_000,
    },
    {
      stage: 'review',
      inputTokens: 20,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      elapsedMs: 46_000,
    },
  ];

  it('formats a fixed-shape duration per row and sums them', () => {
    const table = formatUsageTable(withElapsed);
    expect(table).toContain('elapsed');
    expect(table).toContain('2m14s');
    expect(table).toContain('46s');
    // An issue's stages run sequentially, so the sum is its real elapsed time.
    expect(table).toContain('3m00s');
    expect(aggregateStageUsage(withElapsed).elapsedMs).toBe(180_000);
  });

  it('hides the column entirely for legacy records that never tracked it', () => {
    const table = formatUsageTable([
      { stage: 'implement', inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(table).not.toContain('elapsed');
  });

  it('reports hours without pretending to second precision', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(59_400)).toBe('59s');
    expect(formatElapsed(3_723_000)).toBe('1h02m');
  });
});

describe('peak context', () => {
  const measured = (stage: string, peakContextTokens: number, cacheReadTokens: number): StageUsage => ({
    stage,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens,
    cacheWriteTokens: 0,
    peakContextTokens,
  });

  it('is the largest single request, not the session total', () => {
    // The cumulative figure here is 8M — far past any model's window. The
    // measured peak is what a human can actually reason about.
    const entries = [measured('implement', 229_900, 8_000_000)];
    const aggregate = aggregateStageUsage(entries);
    expect(aggregate.peakContextWindow).toBe(229_900);
    expect(aggregate.peakMeasured).toBe(true);
    expect(formatUsageTable(entries)).toContain('Peak context: 230K tokens');
  });

  it('takes the max across stages, never the sum — stages never coexist', () => {
    const aggregate = aggregateStageUsage([
      measured('implement', 229_900, 0),
      measured('review', 159_600, 0),
    ]);
    expect(aggregate.peakContextWindow).toBe(229_900);
    expect(aggregate.peakStage).toBe('implement');
  });

  it('keeps the pre-compaction high when later requests are smaller', () => {
    // Compaction drops the next request's context; the peak already reached stands.
    const aggregate = aggregateStageUsage([measured('implement', 250_000, 0), measured('verify-fix-1', 40_000, 0)]);
    expect(aggregate.peakContextWindow).toBe(250_000);
  });

  it('falls back to the cumulative estimate and says so when a CLI reports none', () => {
    const entries: StageUsage[] = [
      { stage: 'implement', inputTokens: 5_000, outputTokens: 10, cacheReadTokens: 1_000, cacheWriteTokens: 0 },
    ];
    const aggregate = aggregateStageUsage(entries);
    expect(aggregate.peakContextWindow).toBe(6_000);
    expect(aggregate.peakMeasured).toBe(false);
    const table = formatUsageTable(entries);
    expect(table).toContain('Peak context (est.): 6K tokens');
    expect(table).toContain('ctx~');
  });

  it('labels a mixed run as an estimate rather than implying it is measured', () => {
    const aggregate = aggregateStageUsage([
      measured('implement', 229_900, 0),
      { stage: 'review', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(aggregate.peakMeasured).toBe(false);
  });
});
