/**
 * Token usage / context-window telemetry for loop agent sessions.
 *
 * Each agent CLI session ends with a terminal event carrying cumulative token
 * usage for that session (Cursor/Claude Code: the `result` event's `usage`;
 * Codex: `turn.completed`'s `usage`). Loop normally spawns one fresh session
 * per stage (implement, verify-fix-N, review-round-N, review-fix-N). A
 * usage-limit fallback chain can spawn multiple provider sessions for the same
 * logical stage; each attempt is retained as its own row.
 *
 * **Context reporting.** A session's terminal usage event is *cumulative*, so
 * `inputTokens + cacheReadTokens + cacheWriteTokens` sums every request's
 * input across the whole session — for a long run that reaches millions of
 * tokens, which is meaningless next to a model window of a few hundred
 * thousand. Where a provider reports per-request usage (see
 * `AgentProvider.parseTurnContextTokens`), loop instead records the largest
 * single request as `peakContextTokens` — a real high-water mark, and one a
 * mid-session compaction cannot lower. Providers that report no per-request
 * usage fall back to the cumulative figure, labelled as an estimate so the two
 * are never confused.
 */

import type { AgentCli } from '../config/types.js';
import { cost, detail } from '../logs/style.js';

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type StageUsage = AgentUsage & {
  stage: string;
  /** Which agent CLI ran this stage (omitted when unknown, e.g. legacy records). */
  agentCli?: AgentCli;
  /** Which model ran this stage (omitted when unknown). */
  model?: string;
  /**
   * Wall time of the session, measured around the whole child lifetime — a
   * session killed by a timeout still reports how long it burned. Omitted on
   * legacy records written before elapsed time was tracked.
   */
  elapsedMs?: number;
  /**
   * Largest context a single request in this session occupied. Omitted when the
   * CLI reports no per-request usage (cursor, copilot) — the cumulative
   * estimate stands in, and is labelled as one.
   */
  peakContextTokens?: number;
  /**
   * Dollar cost the CLI reported for this stage. Omitted when the CLI reports
   * none (codex/cursor/copilot) — omitted spend is invisible to `--budget`,
   * which loop warns about at startup.
   */
  costUsd?: number;
};

/** Total *reported* spend across stages. Stages without a reported cost contribute nothing. */
export function totalKnownCostUsd(entries: readonly StageUsage[]): number {
  return entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
}

export function totalTokens(usage: AgentUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * Cumulative input across a session — the fallback when a CLI reports no
 * per-request usage. Deliberately *not* called a context window: for a long
 * session this is far larger than any window the model actually held.
 */
export function contextWindowEstimate(usage: AgentUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** The context figure to show for one stage, and whether it was measured or estimated. */
export function stageContextTokens(entry: StageUsage): { tokens: number; measured: boolean } {
  return entry.peakContextTokens !== undefined
    ? { tokens: entry.peakContextTokens, measured: true }
    : { tokens: contextWindowEstimate(entry), measured: false };
}

/**
 * Extracts usage from a Cursor-shaped `result` event
 * (`usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`).
 * Provider-specific field mappings live in each agent provider's
 * `extractUsage`; this handles the reference (Cursor) shape.
 */
export function parseUsageFromResultEvent(event: unknown): AgentUsage | null {
  if (!event || typeof event !== 'object') return null;
  const usage = (event as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  return {
    inputTokens: usageNumber(u.inputTokens),
    outputTokens: usageNumber(u.outputTokens),
    cacheReadTokens: usageNumber(u.cacheReadTokens),
    cacheWriteTokens: usageNumber(u.cacheWriteTokens),
  };
}

/** Coerce a raw usage field to a finite number, defaulting to 0. */
export function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export type UsageAggregate = {
  totals: AgentUsage;
  totalTokens: number;
  /**
   * The largest context any one stage reached — a **maximum**, never a sum:
   * stages run one after another, so their contexts never coexist.
   */
  peakContextWindow: number;
  peakStage: string | null;
  /** False when any contributing stage had to fall back to the cumulative estimate. */
  peakMeasured: boolean;
  /**
   * Summed session time. One issue's stages run sequentially, so this is that
   * issue's real elapsed time; a whole invocation's rollup spans parallel
   * workers, where it is total *session* time rather than wall-clock.
   */
  elapsedMs: number;
};

export function aggregateStageUsage(entries: StageUsage[]): UsageAggregate {
  const totals: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let peakContextWindow = 0;
  let peakStage: string | null = null;
  let peakMeasured = true;
  let elapsedMs = 0;

  for (const entry of entries) {
    totals.inputTokens += entry.inputTokens;
    totals.outputTokens += entry.outputTokens;
    totals.cacheReadTokens += entry.cacheReadTokens;
    totals.cacheWriteTokens += entry.cacheWriteTokens;
    elapsedMs += entry.elapsedMs ?? 0;

    const context = stageContextTokens(entry);
    if (!context.measured) peakMeasured = false;
    if (context.tokens > peakContextWindow) {
      peakContextWindow = context.tokens;
      peakStage = entry.stage;
    }
  }

  return {
    totals,
    totalTokens: totalTokens(totals),
    peakContextWindow,
    peakStage,
    peakMeasured: entries.length > 0 && peakMeasured,
    elapsedMs,
  };
}

/**
 * Compact human-readable counts for usage tables (e.g. `283`, `90.3K`, `3.45M`).
 * Keeps small values exact; uses up to 3 significant figures with SI suffixes.
 */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;

  const tiers: { threshold: number; suffix: string }[] = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' },
  ];
  for (const { threshold, suffix } of tiers) {
    if (abs >= threshold) {
      const scaled = abs / threshold;
      const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      const fixed = scaled.toFixed(decimals).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
      return `${sign}${fixed}${suffix}`;
    }
  }
  return `${sign}${Math.round(abs)}`;
}

/** Fixed-shape session time for table columns: `48s`, `2m14s`, `1h02m`. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function formatAgentCell(entry: StageUsage): string {
  if (entry.agentCli && entry.model) return `${entry.agentCli}/${entry.model}`;
  return entry.agentCli ?? entry.model ?? '';
}

export function formatUsageTable(entries: StageUsage[]): string {
  if (entries.length === 0) return '(no usage data recorded)';

  // Cost column only when some CLI actually reported cost — an all-blank (or
  // all-"$0.00") column for codex/cursor/copilot runs would just mislead.
  const withCost = entries.some((entry) => entry.costUsd !== undefined);
  const costCell = (costUsd: number | undefined): string[] =>
    withCost ? [costUsd !== undefined ? `$${costUsd.toFixed(2)}` : ''] : [];

  // Same rule as cost: an all-blank column on legacy records would only mislead.
  const withElapsed = entries.some((entry) => entry.elapsedMs !== undefined);
  // `peak-ctx` is a measured high-water mark; `ctx~` is the cumulative fallback.
  const withMeasuredContext = entries.every((entry) => entry.peakContextTokens !== undefined);
  const elapsedCell = (elapsedMs: number | undefined): string[] =>
    withElapsed ? [elapsedMs !== undefined ? formatElapsed(elapsedMs) : ''] : [];

  const header = [
    'stage',
    'agent/model',
    'input',
    'output',
    'cache-read',
    'cache-write',
    withMeasuredContext ? 'peak-ctx' : 'ctx~',
    ...(withElapsed ? ['elapsed'] : []),
    ...(withCost ? ['cost'] : []),
  ];
  const rows = entries.map((entry) => [
    entry.stage,
    formatAgentCell(entry),
    formatCompactNumber(entry.inputTokens),
    formatCompactNumber(entry.outputTokens),
    formatCompactNumber(entry.cacheReadTokens),
    formatCompactNumber(entry.cacheWriteTokens),
    formatCompactNumber(stageContextTokens(entry).tokens),
    ...elapsedCell(entry.elapsedMs),
    ...costCell(entry.costUsd),
  ]);

  const widths = header.map((title, col) =>
    Math.max(title.length, ...rows.map((row) => row[col]?.length ?? 0)),
  );

  const formatRow = (cells: string[]): string =>
    cells.map((cell, col) => cell.padEnd(widths[col] ?? cell.length)).join('  ');

  const aggregate = aggregateStageUsage(entries);
  const totalRow = formatRow([
    'TOTAL',
    '',
    formatCompactNumber(aggregate.totals.inputTokens),
    formatCompactNumber(aggregate.totals.outputTokens),
    formatCompactNumber(aggregate.totals.cacheReadTokens),
    formatCompactNumber(aggregate.totals.cacheWriteTokens),
    // The high-water mark across stages, not a sum. Every other cell in this
    // column is a context window; summing them would produce a number no
    // session ever held, and one that contradicts the peak line below.
    aggregate.peakStage === null ? '' : formatCompactNumber(aggregate.peakContextWindow),
    ...elapsedCell(withElapsed ? aggregate.elapsedMs : undefined),
    ...costCell(withCost ? totalKnownCostUsd(entries) : undefined),
  ]);

  // The header says which figure the column holds, so a mixed run (one CLI
  // reporting per-request usage, another not) can never read as one number.
  const peakLine =
    aggregate.peakStage != null
      ? `Peak context${aggregate.peakMeasured ? '' : ' (est.)'}: ${formatCompactNumber(aggregate.peakContextWindow)} tokens — stage "${aggregate.peakStage}"`
      : 'Peak context: n/a';

  // Only the per-stage breakdown recedes: the total is what a human reads to
  // decide whether a run is worth continuing.
  return [
    detail(formatRow(header)),
    ...rows.map((row) => detail(formatRow(row))),
    formatRow(header.map(() => '')).trimEnd() || '',
    cost(totalRow),
    '',
    peakLine,
  ]
    .filter((line) => line !== '')
    .join('\n');
}
