/**
 * Claude Code CLI provider.
 *
 * `claude -p --output-format stream-json --verbose --include-partial-messages`
 * emits JSONL whose event shapes were confirmed by live smoke tests
 * (claude 2.1.201):
 *
 *   {"type":"system","subtype":"init","model":"claude-sonnet-5",...}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"h"}},...}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"hello"}],...},...}       // consolidated per block
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_..","name":"Write","input":{...}}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_..","content":"..."}]}}
 *   {"type":"result","subtype":"success","is_error":false,"duration_ms":5070,"result":"hello",
 *    "usage":{"input_tokens":2,"cache_creation_input_tokens":10294,"cache_read_input_tokens":15526,"output_tokens":4},...}
 *
 * Thinking blocks follow the Anthropic Messages API stream shape
 * (`content_block_delta` with `{"type":"thinking_delta","thinking":"..."}`);
 * that mapping is from the documented API shape, not a live capture (the
 * smoke-test model didn't emit thinking).
 */

import { usageNumber, type AgentUsage } from '../../usage/tokens.js';
import { truncate } from '../format.js';
import { extractResultTextFromStream, parseAgentJsonResult } from './cursor.js';
import { isSharedInfraError } from './infra-error.js';
import { isSharedUsageLimitError } from './usage-limit.js';
import type { AgentProvider, BuildArgsInput, CanonicalAgentEvent } from './types.js';

const CLAUDE_USAGE_LIMIT_RE = /credit balance is too low|claude (?:ai )?usage limit|monthly usage limit|5-hour limit/i;

/**
 * Claude Code prefixes its own transport failures with `API Error:`. Matched
 * only for the 5xx/connection/timeout variants — `API Error: 400 invalid
 * request` is a real problem with the request and must not be retried.
 */
const CLAUDE_INFRA_ERROR_RE = /api error:\s*(?:5\d\d\b|connection|request timed out)/i;

/**
 * Remote actions are denied on every session via `--disallowedTools` (comma/
 * space-separated list per `claude --help`; `Bash(cmd:*)` matches prefixed
 * variants). bypassPermissions skips approval prompts but denial rules still
 * apply — this is the claude-code counterpart of copilot's `--deny-tool` guard.
 */
export const CLAUDE_DENIED_REMOTE_TOOLS = [
  'Bash(git push)',
  'Bash(git push:*)',
  'Bash(gh pr create)',
  'Bash(gh pr create:*)',
  'Bash(gh pr merge)',
  'Bash(gh pr merge:*)',
  'Bash(gh pr close)',
  'Bash(gh pr close:*)',
  'Bash(gh release)',
  'Bash(gh release:*)',
] as const;

type ClaudeContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
};

/** Whole summaries: only the display knows the prefix width to fit them to. */
function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const command = typeof input.command === 'string' ? input.command : null;
  const description = typeof input.description === 'string' ? input.description : null;
  if (name === 'Bash' && command) {
    return description ? `shell (${description}): ${command}` : `shell: ${command}`;
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : null;
  if (filePath) return `${name.toLowerCase()}: ${filePath}`;

  const pattern = typeof input.pattern === 'string' ? input.pattern : null;
  if (name === 'Grep' && pattern) {
    const where = typeof input.path === 'string' ? ` in ${input.path}` : '';
    return `grep: ${pattern}${where}`;
  }

  return name.toLowerCase();
}

/**
 * Tool *results* keep a cap, unlike summaries: a file read's contents are
 * unbounded, and this is a guard against ferrying them around, not a guess at
 * the line width. The display trims further to whatever the line has left.
 */
function toolResultText(content: unknown): string | null {
  if (typeof content === 'string') return truncate(content, 100);
  if (Array.isArray(content)) {
    const text = content
      .filter((block): block is { type?: string; text?: string } => typeof block === 'object' && block !== null)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join(' ');
    return text.trim() ? truncate(text, 100) : null;
  }
  return null;
}

function contentBlocks(message: unknown): ClaudeContentBlock[] {
  if (!message || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ClaudeContentBlock => typeof block === 'object' && block !== null);
}

export function createClaudeCodeProvider(): AgentProvider {
  /** tool_use_id → summary, so tool_result events can echo the tool they belong to. */
  const toolSummaries = new Map<string, string>();
  /** tool_use_id → Bash command, so tool_result events can emit exec evidence. */
  const pendingShellCommands = new Map<string, string>();

  return {
    id: 'claude-code',
    binaryName: 'claude',

    buildArgs({ prompt, model, effort }: BuildArgsInput): string[] {
      const args = [
        '-p',
        '--permission-mode',
        'bypassPermissions',
        '--disallowedTools',
        CLAUDE_DENIED_REMOTE_TOOLS.join(','),
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
      ];
      // "auto" is loop's own default sentinel, not a Claude model — let the CLI pick.
      if (model && model !== 'auto') args.push('--model', model);
      if (effort) args.push('--effort', effort);
      args.push(prompt);
      return args;
    },

    // Same flag set with `--resume <id>`; claude scopes sessions per cwd, so
    // callers must resume from the worktree the session originally ran in.
    buildResumeArgs(input) {
      const args = this.buildArgs(input);
      args.splice(args.length - 1, 0, '--resume', input.sessionId);
      return args;
    },

    extractSessionId(finalOutput: string): string | null {
      return finalOutput.match(/"session_id"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    },

    parseLine(line: string): CanonicalAgentEvent | null {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { type: 'raw-line', text: truncate(line, 200) };
      }

      const type = event.type;

      if (type === 'system' && event.subtype === 'init') {
        const model = typeof event.model === 'string' ? event.model : '';
        return { type: 'session-start', model };
      }

      if (type === 'stream_event') {
        const inner = event.event as Record<string, unknown> | undefined;
        if (!inner || inner.type !== 'content_block_delta') return null;
        const delta = inner.delta as { type?: string; text?: string; thinking?: string } | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          return { type: 'assistant-text', text: delta.text };
        }
        if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          return { type: 'thinking-text', text: delta.thinking };
        }
        return null;
      }

      if (type === 'assistant') {
        const blocks = contentBlocks(event.message);
        const toolUse = blocks.find((block) => block.type === 'tool_use' && typeof block.name === 'string');
        if (toolUse) {
          const name = toolUse.name ?? 'tool';
          const input = toolUse.input ?? {};
          const summary = summarizeToolUse(name, input);
          if (typeof toolUse.id === 'string') {
            toolSummaries.set(toolUse.id, summary);
            if (name === 'Bash' && typeof input.command === 'string' && input.command) {
              pendingShellCommands.set(toolUse.id, input.command);
            }
          }
          return { type: 'tool-call-start', summary, toolName: name, toolInput: input };
        }

        const thinking = blocks.find((block) => block.type === 'thinking');
        if (thinking) return { type: 'thinking-text', text: '', completed: true };

        const text = blocks
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text ?? '')
          .join('');
        return { type: 'assistant-text', text, consolidated: true };
      }

      if (type === 'user') {
        const blocks = contentBlocks(event.message);
        const toolResult = blocks.find((block) => block.type === 'tool_result');
        if (!toolResult) return null;
        const toolUseId = typeof toolResult.tool_use_id === 'string' ? toolResult.tool_use_id : null;
        const summary = (toolUseId ? toolSummaries.get(toolUseId) : undefined) ?? 'tool';
        const command = toolUseId ? pendingShellCommands.get(toolUseId) : undefined;
        if (toolUseId) pendingShellCommands.delete(toolUseId);
        const isError = (toolResult as { is_error?: unknown }).is_error === true;
        return {
          type: 'tool-call-result',
          summary,
          result: toolResultText(toolResult.content),
          ...(command ? { exec: { command, ok: !isError } } : {}),
        };
      }

      if (type === 'result') {
        return {
          type: 'result',
          ok: event.is_error !== true,
          durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : 0,
          text: typeof event.result === 'string' && event.result.trim() ? event.result : null,
        };
      }

      return null;
    },

    /**
     * Each `assistant` event carries the usage of the request that produced
     * it, so `input + cache_read + cache_creation` is that request's context
     * occupancy. The terminal `result` event sums these across the session and
     * is therefore useless for a peak.
     */
    parseTurnContextTokens(line: string): number | null {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return null;
      }
      const event = parsed as { type?: unknown; message?: { usage?: unknown } };
      if (event.type !== 'assistant') return null;
      const usage = event.message?.usage;
      if (!usage || typeof usage !== 'object') return null;
      const u = usage as Record<string, unknown>;
      const context =
        usageNumber(u.input_tokens) +
        usageNumber(u.cache_read_input_tokens) +
        usageNumber(u.cache_creation_input_tokens);
      return context > 0 ? context : null;
    },

    // Claude Code's terminal `result` event has the same shape as Cursor's.
    extractResultText(finalOutput: string): string {
      return extractResultTextFromStream(finalOutput);
    },

    extractUsage(finalOutput: string): AgentUsage | null {
      const parsed = parseAgentJsonResult(finalOutput);
      const usage = parsed?.usage;
      if (!usage || typeof usage !== 'object') return null;
      const u = usage as Record<string, unknown>;
      return {
        inputTokens: usageNumber(u.input_tokens),
        outputTokens: usageNumber(u.output_tokens),
        cacheReadTokens: usageNumber(u.cache_read_input_tokens),
        cacheWriteTokens: usageNumber(u.cache_creation_input_tokens),
      };
    },

    // Claude Code is the only supported CLI whose stream reports dollar cost.
    extractCostUsd(finalOutput: string): number | null {
      const parsed = parseAgentJsonResult(finalOutput) as { total_cost_usd?: unknown } | null;
      return typeof parsed?.total_cost_usd === 'number' ? parsed.total_cost_usd : null;
    },

    isUsageLimitError(text: string): boolean {
      return isSharedUsageLimitError(text) || CLAUDE_USAGE_LIMIT_RE.test(text);
    },

    isInfraError(text: string): boolean {
      return isSharedInfraError(text) || CLAUDE_INFRA_ERROR_RE.test(text);
    },
  };
}
