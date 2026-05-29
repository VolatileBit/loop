/**
 * Cursor agent CLI provider — the reference implementation, ported from the
 * original scripts/loop-loop.ts stream-json parsing.
 *
 * `cursor agent --output-format stream-json --stream-partial-output` streams
 * assistant/thinking text as *incremental* token deltas (each event carries
 * only the new piece), then sometimes — but not always — a consolidated event
 * with the full text and a `model_call_id`. The consolidated events map to
 * `consolidated: true` canonical events so the display can prefer their
 * canonical text over accumulated deltas.
 */

import { parseUsageFromResultEvent, type AgentUsage } from '../../usage/tokens.js';
import { truncate } from '../format.js';
import { isSharedInfraError } from './infra-error.js';
import { isSharedUsageLimitError } from './usage-limit.js';
import type { AgentProvider, BuildArgsInput, CanonicalAgentEvent } from './types.js';

/** Whole summaries: only the display knows the prefix width to fit them to. */
function summarizeToolCall(toolCall: Record<string, unknown>): string {
  const shell = toolCall.shellToolCall as { args?: { command?: string; description?: string } } | undefined;
  if (shell?.args?.command) {
    return shell.args.description
      ? `shell (${shell.args.description}): ${shell.args.command}`
      : `shell: ${shell.args.command}`;
  }

  const read = toolCall.readToolCall as { args?: { path?: string } } | undefined;
  if (read?.args?.path) return `read: ${read.args.path}`;

  const edit = toolCall.editToolCall as { args?: { path?: string } } | undefined;
  if (edit?.args?.path) return `edit: ${edit.args.path}`;

  const write = toolCall.writeToolCall as { args?: { path?: string } } | undefined;
  if (write?.args?.path) return `write: ${write.args.path}`;

  const grep = toolCall.grepToolCall as { args?: { pattern?: string; path?: string } } | undefined;
  if (grep?.args?.pattern) {
    const where = grep.args.path ? ` in ${grep.args.path}` : '';
    return `grep: ${grep.args.pattern}${where}`;
  }

  const keys = Object.keys(toolCall).filter((key) => key.endsWith('ToolCall'));
  return keys[0]?.replace(/ToolCall$/, '') ?? 'tool';
}

type EditLikeResult = {
  result?: {
    success?: { linesAdded?: number; linesRemoved?: number };
    error?: { message?: string };
  };
};

function summarizeEditResult(toolCall: Record<string, unknown>, key: string): string | null {
  const call = toolCall[key] as EditLikeResult | undefined;
  if (call?.result?.success) {
    const added = call.result.success.linesAdded ?? 0;
    const removed = call.result.success.linesRemoved ?? 0;
    return `+${added} -${removed}`;
  }
  if (call?.result?.error?.message) return `failed: ${truncate(call.result.error.message, 100)}`;
  return null;
}

function summarizeToolResult(toolCall: Record<string, unknown>): string | null {
  const shell = toolCall.shellToolCall as {
    result?: { success?: { exitCode?: number; executionTime?: number }; error?: { message?: string } };
  } | undefined;
  if (shell?.result?.success) {
    const exit = shell.result.success.exitCode ?? '?';
    const ms = shell.result.success.executionTime;
    return ms != null ? `exit ${exit} (${ms}ms)` : `exit ${exit}`;
  }
  if (shell?.result?.error?.message) return `failed: ${truncate(shell.result.error.message, 100)}`;

  if ('editToolCall' in toolCall) return summarizeEditResult(toolCall, 'editToolCall');
  if ('writeToolCall' in toolCall) return summarizeEditResult(toolCall, 'writeToolCall');

  return null;
}

/**
 * Structured tool identity for the evidence tracker: the `<name>ToolCall` key
 * gives the name (`shell`, `read`, `edit`, `write`, `grep`, …) and its `args`
 * the input. Null when the wrapper object has no recognizable call key.
 */
function toolIdentity(toolCall: Record<string, unknown>): { name: string; input: Record<string, unknown> } | null {
  const key = Object.keys(toolCall).find((candidate) => candidate.endsWith('ToolCall'));
  if (!key) return null;
  const call = toolCall[key] as { args?: unknown } | undefined;
  const args = call && typeof call.args === 'object' && call.args !== null ? (call.args as Record<string, unknown>) : {};
  return { name: key.replace(/ToolCall$/, ''), input: args };
}

function shellExecObservation(toolCall: Record<string, unknown>): { command: string; ok: boolean } | null {
  const identity = toolIdentity(toolCall);
  const command = identity?.input.command;
  if (typeof command !== 'string' || !command) return null;
  const key = Object.keys(toolCall).find((candidate) => candidate.endsWith('ToolCall'))!;
  const call = toolCall[key] as { result?: { error?: unknown } } | undefined;
  return { command, ok: call?.result?.error === undefined };
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text?: string } => typeof block === 'object' && block !== null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
}

/** Last `type: "result"` JSON event in a cursor/claude-shaped stream log, if any. */
export function parseAgentJsonResult(output: string): {
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  usage?: unknown;
} | null {
  for (const line of output.trim().split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        is_error?: boolean;
        result?: string;
        duration_ms?: number;
        usage?: unknown;
      };
      if (parsed.type === 'result') return parsed;
    } catch {
      // keep scanning
    }
  }
  return null;
}

/** Final assistant text from a cursor/claude-shaped stream log (`result` event's `result` string). */
export function extractResultTextFromStream(finalOutput: string): string {
  for (const line of finalOutput.trim().split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; result?: string };
      if (parsed.type === 'result' && typeof parsed.result === 'string' && parsed.result.trim()) {
        return parsed.result;
      }
    } catch {
      // keep scanning
    }
  }
  return finalOutput;
}

export function createCursorProvider(): AgentProvider {
  return {
    id: 'cursor',
    binaryName: 'cursor',

    buildArgs({ prompt, model, cwd }: BuildArgsInput): string[] {
      const args = [
        'agent',
        '-p',
        '--trust',
        '--force',
        '--approve-mcps',
        '--workspace',
        cwd,
        '--output-format',
        'stream-json',
        '--stream-partial-output',
      ];
      if (model) args.push('--model', model);
      args.push(prompt);
      return args;
    },

    // `cursor agent --resume <chatId>` with the same headless flags.
    buildResumeArgs(input) {
      const args = this.buildArgs(input);
      args.splice(args.length - 1, 0, '--resume', input.sessionId);
      return args;
    },

    extractSessionId(finalOutput: string): string | null {
      return (
        finalOutput.match(/"chatId"\s*:\s*"([^"]+)"/)?.[1] ??
        finalOutput.match(/"session_id"\s*:\s*"([^"]+)"/)?.[1] ??
        null
      );
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

      if (type === 'thinking') {
        if (event.subtype === 'delta' && typeof event.text === 'string') {
          return { type: 'thinking-text', text: event.text };
        }
        if (event.subtype === 'completed') return { type: 'thinking-text', text: '', completed: true };
        return null;
      }

      if (type === 'assistant') {
        const text = extractAssistantText(event.message);
        // Consolidated messages carry a model_call_id and the full text; the
        // display prefers their canonical text over the accumulated deltas.
        if (event.model_call_id != null) {
          return { type: 'assistant-text', text, consolidated: true };
        }
        return text ? { type: 'assistant-text', text } : null;
      }

      if (type === 'tool_call') {
        const toolCall = event.tool_call as Record<string, unknown> | undefined;
        if (!toolCall) return null;
        const summary = summarizeToolCall(toolCall);
        if (event.subtype === 'started') {
          const identity = toolIdentity(toolCall);
          return {
            type: 'tool-call-start',
            summary,
            ...(identity ? { toolName: identity.name, toolInput: identity.input } : {}),
          };
        }
        if (event.subtype === 'completed') {
          const exec = shellExecObservation(toolCall);
          return {
            type: 'tool-call-result',
            summary,
            result: summarizeToolResult(toolCall),
            ...(exec ? { exec } : {}),
          };
        }
        return null;
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

    extractResultText(finalOutput: string): string {
      return extractResultTextFromStream(finalOutput);
    },

    extractUsage(finalOutput: string): AgentUsage | null {
      return parseUsageFromResultEvent(parseAgentJsonResult(finalOutput));
    },

    // The cursor stream reports no dollar cost — cursor spend is invisible to --budget.
    extractCostUsd(): number | null {
      return null;
    },

    isUsageLimitError(text: string): boolean {
      return isSharedUsageLimitError(text);
    },

    // No cursor-specific phrasing observed beyond the shared set.
    isInfraError(text: string): boolean {
      return isSharedInfraError(text);
    },

    // Cursor reports usage only on the terminal `result` event, which is
    // cumulative — there is no per-request figure to take a peak from.
    parseTurnContextTokens(): number | null {
      return null;
    },
  };
}
