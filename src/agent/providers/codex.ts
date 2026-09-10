/**
 * Codex CLI provider.
 *
 * `codex exec --json` emits a coarse JSONL event stream (no token deltas),
 * confirmed by live smoke tests (codex-cli 0.142.2):
 *
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"...","exit_code":null,"status":"in_progress"}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"...","exit_code":0,"status":"completed"}}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello"}}
 *   {"type":"turn.completed","usage":{"input_tokens":16463,"cached_input_tokens":16128,"output_tokens":5,"reasoning_output_tokens":0}}
 *
 * Note `input_tokens` *includes* `cached_input_tokens`, so the canonical
 * mapping subtracts the cached portion to keep the context-window estimate
 * comparable across providers. There is no wall-duration field, so `result`
 * events report `durationMs: 0` (rendered as "unknown duration"). The
 * `reasoning` and `turn.failed` mappings follow Codex's documented event
 * schema; the smoke-test runs did not emit them.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { usageNumber, type AgentUsage } from '../../usage/tokens.js';
import { truncate } from '../format.js';
import { isSharedInfraError } from './infra-error.js';
import { isSharedUsageLimitError } from './usage-limit.js';
import type { AgentProvider, BuildArgsInput, CanonicalAgentEvent } from './types.js';

const CODEX_USAGE_LIMIT_RE = /insufficient_quota|usage_limit|plan limit/i;

/** Codex reports a severed response stream before it reports anything about the work. */
const CODEX_INFRA_ERROR_RE = /stream (?:error|disconnected|closed unexpectedly)/i;

type CodexItem = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  query?: string;
  message?: string;
};

/** Whole summaries: only the display knows the prefix width to fit them to. */
function summarizeItem(item: CodexItem): string {
  if (item.type === 'command_execution') return `shell: ${item.command ?? ''}`;
  if (item.type === 'file_change') {
    const paths = (item.changes ?? [])
      .map((change) => change.path)
      .filter((p): p is string => typeof p === 'string');
    return paths.length > 0 ? `edit: ${paths.join(', ')}` : 'edit';
  }
  if (item.type === 'mcp_tool_call') return `mcp: ${[item.server, item.tool].filter(Boolean).join('.')}`;
  if (item.type === 'web_search') return `web-search: ${item.query ?? ''}`;
  return item.type ?? 'tool';
}

function parseCodexEvent(line: string): { type?: string; item?: CodexItem; usage?: unknown; error?: { message?: string } } | null {
  try {
    return JSON.parse(line) as { type?: string; item?: CodexItem; usage?: unknown; error?: { message?: string } };
  } catch {
    return null;
  }
}

/** Structured tool identity for the evidence tracker (agent/evidence.ts). */
function toolInputForItem(item: CodexItem): Record<string, unknown> {
  if (item.type === 'command_execution' && typeof item.command === 'string') {
    return { command: item.command };
  }
  if (item.type === 'file_change') {
    const paths = (item.changes ?? [])
      .map((change) => change.path)
      .filter((p): p is string => typeof p === 'string');
    return { paths };
  }
  return {};
}

/**
 * Peak context occupancy for a finished codex session, read from its rollout.
 *
 * Codex's `--json` stream carries no usage events, so loop had been reading
 * `turn.completed.input_tokens` — a session-cumulative total that reached
 * millions and was printed as a context window. The rollout keeps what the
 * stream drops: one `token_count` per request, whose `last_token_usage`
 * describes that request alone. `input_tokens` there already includes the
 * cached portion (see `extractUsage`, which subtracts it to get the uncached
 * part), so it *is* the occupancy — never sum it with `cached_input_tokens`.
 *
 * The maximum across those records is the high-water mark, which is the point:
 * it survives compaction. A session that runs to 80% of the window, compacts
 * to 10% and climbs to 70% peaked at 80%, and only a running max says so.
 *
 * Rollouts live at `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<id>.jsonl`.
 * That layout is undocumented, so every failure here is silent: an unreadable
 * or missing rollout returns null and loop falls back to the labelled estimate.
 */
export function codexRolloutContextPeak(sessionId: string): number | null {
  if (!/^[0-9a-f-]{16,64}$/i.test(sessionId)) return null;
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const file = findRollout(root, `-${sessionId}.jsonl`, 4);
  if (!file) return null;
  try {
    return peakFromRolloutLines(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The high-water mark across a rollout's `token_count` records; null when it has none. */
export function peakFromRolloutLines(text: string): number | null {
  let peak = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('token_count')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = (parsed as { payload?: { type?: unknown; info?: unknown } }).payload;
    if (payload?.type !== 'token_count') continue;
    const info = payload.info as { last_token_usage?: Record<string, unknown> } | undefined;
    const context = usageNumber(info?.last_token_usage?.input_tokens);
    if (context > peak) peak = context;
  }
  return peak > 0 ? peak : null;
}

/** Newest-first search for a rollout whose name ends with `suffix`, bounded in depth. */
function findRollout(dir: string, suffix: string, depth: number): string | null {
  if (depth < 0) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (entry.endsWith(suffix)) return full;
    try {
      if (statSync(full).isDirectory()) dirs.push(full);
    } catch {
      // Unreadable entry: skip it rather than fail the whole search.
    }
  }
  for (const child of dirs.sort().reverse()) {
    const found = findRollout(child, suffix, depth - 1);
    if (found) return found;
  }
  return null;
}

export function createCodexProvider(): AgentProvider {
  return {
    id: 'codex',
    binaryName: 'codex',

    buildArgs({ prompt, model, effort }: BuildArgsInput): string[] {
      const args = ['exec', prompt, '--sandbox', 'workspace-write', '-c', 'approval_policy=never', '--json'];
      // "auto" is loop's own default sentinel, not a Codex model — let the CLI pick.
      if (model && model !== 'auto') args.push('-m', model);
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
      return args;
    },

    // `codex exec resume <id> <prompt>` with the same sandbox/json policy.
    // `exec resume` has no `--sandbox` flag — passing one aborts the process
    // before it starts — so the identical policy goes through `-c` instead.
    buildResumeArgs({ prompt, model, effort, sessionId }) {
      const args = ['exec', 'resume', sessionId, prompt, '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy=never', '--json'];
      if (model && model !== 'auto') args.push('-m', model);
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
      return args;
    },

    extractSessionId(finalOutput: string): string | null {
      return (
        finalOutput.match(/"thread_id"\s*:\s*"([^"]+)"/)?.[1] ??
        finalOutput.match(/"session_id"\s*:\s*"([^"]+)"/)?.[1] ??
        null
      );
    },

    parseLine(line: string): CanonicalAgentEvent | null {
      const event = parseCodexEvent(line);
      if (!event) return { type: 'raw-line', text: truncate(line, 200) };

      const type = event.type;

      // No model field in thread.started; run-agent logs the resolved model itself.
      if (type === 'thread.started') return { type: 'session-start', model: '' };

      if (type === 'item.started') {
        const item = event.item;
        if (!item) return null;
        if (item.type === 'agent_message' || item.type === 'reasoning' || item.type === 'todo_list') return null;
        return {
          type: 'tool-call-start',
          summary: summarizeItem(item),
          toolName: item.type ?? 'tool',
          toolInput: toolInputForItem(item),
        };
      }

      if (type === 'item.completed') {
        const item = event.item;
        if (!item) return null;
        if (item.type === 'agent_message') {
          return { type: 'assistant-text', text: item.text ?? '', consolidated: true };
        }
        if (item.type === 'reasoning') {
          return { type: 'thinking-text', text: item.text ?? '', completed: true };
        }
        if (item.type === 'error') {
          return { type: 'raw-line', text: `codex error: ${truncate(item.message ?? '', 200)}` };
        }
        if (item.type === 'todo_list') return null;
        const isExec = item.type === 'command_execution' && typeof item.command === 'string' && item.command;
        const result =
          item.type === 'command_execution' && item.exit_code != null ? `exit ${item.exit_code}` : null;
        return {
          type: 'tool-call-result',
          summary: summarizeItem(item),
          result,
          ...(isExec ? { exec: { command: item.command as string, ok: item.exit_code === 0 } } : {}),
        };
      }

      if (type === 'turn.completed') {
        return { type: 'result', ok: true, durationMs: 0, text: null };
      }

      if (type === 'turn.failed') {
        const message = event.error?.message;
        return { type: 'result', ok: false, durationMs: 0, text: message ?? null };
      }

      if (type === 'error') {
        return { type: 'raw-line', text: `codex error: ${truncate(event.error?.message ?? line, 200)}` };
      }

      return null;
    },

    /** Last agent_message text — the agent's final response (## Loop commit/handoff blocks live there). */
    extractResultText(finalOutput: string): string {
      for (const line of finalOutput.trim().split('\n').reverse()) {
        if (!line.trim()) continue;
        const event = parseCodexEvent(line);
        if (
          event?.type === 'item.completed' &&
          event.item?.type === 'agent_message' &&
          typeof event.item.text === 'string' &&
          event.item.text.trim()
        ) {
          return event.item.text;
        }
      }
      return finalOutput;
    },

    /**
     * Always null: codex exposes no per-request context. It emits a single
     * `turn.completed` for the whole session, and its `input_tokens` is the
     * cumulative input across every model call in that turn — one 45-minute
     * session reported 797,365 against a context window of roughly 260,000.
     * Reading it as per-request occupancy produced "peak context" figures in
     * the millions, which is a token total wearing a context window's name and
     * invites exactly the wrong inference (it was read here as evidence of
     * mid-session compaction). Without a per-request signal, loop falls back to
     * `contextWindowEstimate`, which is labelled `(est.)` and documented as
     * deliberately not a context window. An honest estimate beats a measured
     * number that measures something else.
     */
    parseTurnContextTokens(): number | null {
      return null;
    },

    sessionContextPeak(sessionId: string): number | null {
      return codexRolloutContextPeak(sessionId);
    },

    extractUsage(finalOutput: string): AgentUsage | null {
      for (const line of finalOutput.trim().split('\n').reverse()) {
        if (!line.trim()) continue;
        const event = parseCodexEvent(line);
        if (event?.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
          const u = event.usage as Record<string, unknown>;
          const input = usageNumber(u.input_tokens);
          const cached = usageNumber(u.cached_input_tokens);
          return {
            inputTokens: Math.max(0, input - cached),
            outputTokens: usageNumber(u.output_tokens),
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
          };
        }
      }
      return null;
    },

    // The codex stream reports no dollar cost — codex spend is invisible to --budget.
    extractCostUsd(): number | null {
      return null;
    },

    isUsageLimitError(text: string): boolean {
      return isSharedUsageLimitError(text) || CODEX_USAGE_LIMIT_RE.test(text);
    },

    isInfraError(text: string): boolean {
      return isSharedInfraError(text) || CODEX_INFRA_ERROR_RE.test(text);
    },
  };
}
