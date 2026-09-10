/**
 * The provider seam that normalizes each agent CLI's raw stdout into a small
 * canonical event set before it reaches the stream display, plus the
 * per-provider hooks run-agent.ts needs (arg-building, final-result/usage
 * extraction, usage-limit sniffing).
 */

import type { AgentCli } from '../../config/types.js';
import type { AgentUsage } from '../../usage/tokens.js';

/**
 * A shell command the session ran, with its harness-recorded outcome — the
 * raw material of the evidence tracker's verify-skip decision (agent/evidence.ts).
 */
export type ExecObservation = { command: string; ok: boolean };

export type CanonicalAgentEvent =
  | { type: 'session-start'; model: string }
  /**
   * Incremental assistant text. `consolidated: true` marks a event carrying the
   * *full* canonical text of the current block (e.g. Cursor's model_call_id
   * messages, Claude's complete `assistant` messages) — the display replaces
   * its accumulated deltas with it and flushes.
   */
  | { type: 'assistant-text'; text: string; consolidated?: boolean }
  /** Incremental thinking text. `completed: true` marks the end of a thinking block (flush point). */
  | { type: 'thinking-text'; text: string; completed?: boolean }
  /**
   * `toolName`/`toolInput` carry the tool call's structured identity for the
   * evidence tracker (the display only uses `summary`). Omitted when the
   * provider cannot recover them — the tracker treats that conservatively.
   */
  | { type: 'tool-call-start'; summary: string; toolName?: string; toolInput?: Record<string, unknown> }
  /**
   * `exec` is present when this result closes a shell command whose outcome
   * the harness recorded (evidence for the verify-skip gate).
   */
  | { type: 'tool-call-result'; summary: string; result: string | null; exec?: ExecObservation }
  /** A raw non-event line worth surfacing verbatim (e.g. unparseable stdout). */
  | { type: 'raw-line'; text: string }
  /** Terminal event. `durationMs` is 0 when the CLI doesn't report one. */
  | { type: 'result'; ok: boolean; durationMs: number; text: string | null };

export type BuildArgsInput = {
  prompt: string;
  /** Resolved model, or null/"auto" to use the CLI's own default. */
  model: string | null;
  /** Resolved effort/reasoning intensity, or null to use the CLI's own default. */
  effort: string | null;
  /** The working root the agent operates on (main repo or a worktree). */
  cwd: string;
  /** How much the sandbox may reach; see `LoopConfig.sandboxMode`. */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined;
  /** Adds network and Docker reach to a `workspace-write` sandbox. */
  sandboxNetworkAccess?: boolean | undefined;
};

export type BuildResumeArgsInput = BuildArgsInput & {
  /** The dead session's id, as previously extracted via extractSessionId(). */
  sessionId: string;
};

export interface AgentProvider {
  readonly id: AgentCli;
  /** Executable name, used for spawn and the startup `command -v` availability check. */
  readonly binaryName: string;
  buildArgs(input: BuildArgsInput): string[];
  /**
   * Args to resume a previous session headlessly with a continuation prompt
   * (used after usage-limit waits so in-context work isn't re-derived), or
   * null when this CLI cannot resume — the caller falls back to a fresh
   * session built from the checkpoint + handoff.
   */
  buildResumeArgs(input: BuildResumeArgsInput): string[] | null;
  /**
   * The session/thread/chat id from the CLI's own stream (best-effort; null
   * when the stream carried none). Feeds buildResumeArgs on a later attempt.
   */
  extractSessionId(finalOutput: string): string | null;
  /**
   * Normalizes one stdout line into a canonical event (null = ignore).
   * May keep per-session state — always obtain a fresh provider instance per
   * agent run via resolveAgentProvider().
   */
  parseLine(line: string): CanonicalAgentEvent | null;
  /** Final assistant text (for parsing ## Loop commit/handoff/nits blocks); falls back to the whole output. */
  extractResultText(finalOutput: string): string;
  extractUsage(finalOutput: string): AgentUsage | null;
  /**
   * Tokens occupying the model's context for **one request**, from a single
   * streaming line — or null when the line carries no per-request usage.
   *
   * This exists because a session's terminal usage event is *cumulative*:
   * summing a long run's cache reads produces figures in the millions, which
   * is meaningless as a "context window" when the model's window is a few
   * hundred thousand. Loop takes the maximum of these per-request values
   * instead, which is a real high-water mark — and one a mid-session
   * compaction cannot lower, since the earlier peak stands.
   *
   * Providers that report no per-request usage return null throughout; loop
   * then falls back to the cumulative estimate and labels it as such.
   */
  parseTurnContextTokens(line: string): number | null;
  /**
   * Peak context occupancy for a finished session, for CLIs that keep
   * per-request usage somewhere other than the event stream. Codex is the
   * case: its `--json` stream carries no usage events, but its rollout file
   * records one `token_count` per request. Returning a value here overrides
   * whatever `parseTurnContextTokens` accumulated, because a provider only
   * implements it when it has the better measurement.
   */
  sessionContextPeak?(sessionId: string): number | null;
  /**
   * Dollar cost of the session as reported by the CLI, or null when the CLI
   * reports none (codex/cursor/copilot) — null spend is invisible to --budget,
   * which loop warns about at startup.
   */
  extractCostUsd(finalOutput: string): number | null;
  isUsageLimitError(text: string): boolean;
  /**
   * True when the session died to the provider's own infrastructure (dropped
   * connection, overloaded backend, 5xx) rather than to anything about the
   * work — the one failure class worth retrying in place. Implementations
   * extend `isSharedInfraError` so a CLI-specific phrasing can only widen the
   * shared set, never loosen it. Checked only after `isUsageLimitError`.
   */
  isInfraError(text: string): boolean;
}
