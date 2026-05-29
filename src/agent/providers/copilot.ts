/**
 * GitHub Copilot CLI provider.
 *
 * `copilot -p <prompt> --output-format json` runs non-interactively and emits
 * JSONL — one JSON object per line. Event shapes were probed against copilot
 * 1.0.71 (see the copilot-provider PRD):
 *
 *   {"type":"assistant.reasoning","data":{"content":"…"},"id":"…",…}            // consolidated
 *   {"type":"assistant.message","data":{"content":"…","outputTokens":42},…}     // consolidated
 *   {"type":"assistant.message_delta","data":{…},"ephemeral":true,…}            // incremental
 *   {"type":"tool.execution_start","data":{"toolCallId":"…","toolName":"bash","arguments":{"command":"…"}},…}
 *   {"type":"tool.execution_complete","data":{"toolCallId":"…","success":true,"result":…},…}
 *   {"type":"session.error","data":{"message":"…"},…}
 *   {"type":"result","sessionId":"…","exitCode":0,
 *    "usage":{"premiumRequests":1,"totalApiDurationMs":123,"sessionDurationMs":456,"codeChanges":…}}
 *
 * Consolidated events carry full content; `*_delta` events are incremental and
 * marked `ephemeral` — only consolidated events are surfaced. The terminal
 * `result` event carries its fields at the *top level* (not under `data`), and
 * the stream reports **no dollar cost and no input-token counts** — copilot
 * spend is invisible to `--budget`, same caveat as codex/cursor.
 */

import type { AgentUsage } from '../../usage/tokens.js';
import { truncate } from '../format.js';
import { isSharedInfraError } from './infra-error.js';
import { isSharedUsageLimitError } from './usage-limit.js';
import type { AgentProvider, BuildArgsInput, CanonicalAgentEvent } from './types.js';

const COPILOT_USAGE_LIMIT_RE =
  /premium request.{0,40}(?:limit|exceed|exhaust)|out of (?:ai )?credits|quota (?:exceeded|reached)|rate.?limit/i;

/** Copilot reports transport failures as a status against the request, not the work. */
const COPILOT_INFRA_ERROR_RE = /request failed with status\s*:?\s*5\d\d/i;

/**
 * Remote actions are denied per-command: copilot judges shell approval on a
 * first-level-subcommand basis (`git push`, `gh pr create`), `:*` matches
 * prefixed variants, and denial rules take precedence over allow rules — even
 * `--allow-all-tools`. This is the copilot counterpart of claude-code's
 * `--disallowedTools` guard.
 */
export const COPILOT_DENIED_REMOTE_TOOLS = [
  'shell(git push)',
  'shell(git push:*)',
  'shell(gh pr create)',
  'shell(gh pr create:*)',
  'shell(gh pr merge)',
  'shell(gh pr merge:*)',
  'shell(gh pr close)',
  'shell(gh pr close:*)',
  'shell(gh release)',
  'shell(gh release:*)',
] as const;

type CopilotEventData = {
  content?: unknown;
  outputTokens?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  arguments?: unknown;
  success?: unknown;
  result?: unknown;
  message?: unknown;
};

type CopilotEvent = {
  type?: string;
  data?: CopilotEventData;
  ephemeral?: boolean;
  // Terminal `result` event fields (top level, not under data):
  sessionId?: unknown;
  exitCode?: unknown;
  usage?: { premiumRequests?: unknown; totalApiDurationMs?: unknown; sessionDurationMs?: unknown };
};

function parseCopilotEvent(line: string): CopilotEvent | null {
  try {
    return JSON.parse(line) as CopilotEvent;
  } catch {
    return null;
  }
}

/** Whole summaries: only the display knows the prefix width to fit them to. */
function summarizeTool(toolName: string, args: Record<string, unknown>): string {
  const command = typeof args.command === 'string' ? args.command : null;
  if (toolName === 'bash' && command) return `shell: ${command}`;
  const path = typeof args.path === 'string' ? args.path : null;
  if (path) return `${toolName}: ${path}`;
  return toolName;
}

export function createCopilotProvider(): AgentProvider {
  /** toolCallId → summary, so execution_complete events can echo their tool. */
  const toolSummaries = new Map<string, string>();
  /** toolCallId → shell command, so completions can emit exec evidence. */
  const pendingShellCommands = new Map<string, string>();
  /** Last consolidated assistant text — the terminal result event carries none itself. */
  let lastAssistantMessage: string | null = null;
  /** Last session.error message — surfaced as the result text of a failed run. */
  let lastSessionError: string | null = null;

  return {
    id: 'copilot',
    binaryName: 'copilot',

    buildArgs({ prompt, model, effort }: BuildArgsInput): string[] {
      return [
        '-p',
        prompt,
        // Required for non-interactive mode; the deny list below still wins —
        // copilot applies denial rules over every allow rule.
        '--allow-all-tools',
        // Worktree git operations write through the shared `.git/worktrees/`
        // gitdir outside the sandbox cwd, which copilot's path verification
        // would otherwise block (matches claude-code's bypassPermissions posture).
        '--allow-all-paths',
        // Nobody is there to answer.
        '--no-ask-user',
        '--output-format',
        'json',
        '--no-color',
        '--no-auto-update',
        // Sessions must not be exported to GitHub web/mobile.
        '--no-remote-export',
        ...COPILOT_DENIED_REMOTE_TOOLS.flatMap((tool) => ['--deny-tool', tool]),
        // "auto" is loop's own default sentinel, not a copilot model — let the CLI pick.
        ...(model && model !== 'auto' ? ['--model', model] : []),
        ...(effort ? ['--effort', effort] : []),
      ];
    },

    // Same flag set with `--resume=<id>`; the -p prompt is the continuation.
    buildResumeArgs(input) {
      return [...this.buildArgs(input), `--resume=${input.sessionId}`];
    },

    extractSessionId(finalOutput: string): string | null {
      return finalOutput.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    },

    parseLine(line: string): CanonicalAgentEvent | null {
      const event = parseCopilotEvent(line);
      if (!event) return { type: 'raw-line', text: truncate(line, 200) };

      const type = event.type;
      const data = event.data ?? {};

      if (type === 'assistant.message') {
        const content = typeof data.content === 'string' ? data.content : '';
        if (!content) return null;
        lastAssistantMessage = content;
        return { type: 'assistant-text', text: content, consolidated: true };
      }

      if (type === 'assistant.reasoning') {
        const content = typeof data.content === 'string' ? data.content : '';
        if (!content) return null;
        return { type: 'thinking-text', text: content, completed: true };
      }

      if (type === 'tool.execution_start') {
        const toolName = typeof data.toolName === 'string' ? data.toolName : 'tool';
        const args =
          typeof data.arguments === 'object' && data.arguments !== null
            ? (data.arguments as Record<string, unknown>)
            : {};
        const summary = summarizeTool(toolName, args);
        if (typeof data.toolCallId === 'string' && data.toolCallId) {
          toolSummaries.set(data.toolCallId, summary);
          if (toolName === 'bash' && typeof args.command === 'string' && args.command) {
            pendingShellCommands.set(data.toolCallId, args.command);
          }
        }
        return { type: 'tool-call-start', summary, toolName, toolInput: args };
      }

      if (type === 'tool.execution_complete') {
        const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : null;
        const summary = (toolCallId ? toolSummaries.get(toolCallId) : undefined) ?? 'tool';
        const ok = data.success === true;
        const command = toolCallId ? pendingShellCommands.get(toolCallId) : undefined;
        if (toolCallId) pendingShellCommands.delete(toolCallId);
        return {
          type: 'tool-call-result',
          summary,
          result: ok ? null : `failed: ${truncate(String(data.result ?? ''), 2000)}`,
          ...(command ? { exec: { command, ok } } : {}),
        };
      }

      if (type === 'session.error') {
        const message = typeof data.message === 'string' ? data.message : '';
        if (message) lastSessionError = message;
        return { type: 'raw-line', text: `copilot error: ${truncate(message || line, 200)}` };
      }

      if (type === 'result') {
        const ok = event.exitCode === 0;
        const durationMs =
          typeof event.usage?.sessionDurationMs === 'number' ? event.usage.sessionDurationMs : 0;
        // The terminal event carries no text of its own: surface the last
        // assistant message, or the session error a failed run died on (also
        // how quota phrasings reach the usage-limit probe — they arrive on
        // stdout, not stderr).
        const text = lastAssistantMessage ?? lastSessionError;
        return { type: 'result', ok, durationMs, text };
      }

      // Deltas (`ephemeral`), session/mcp housekeeping, turn markers: ignore.
      return null;
    },

    extractResultText(finalOutput: string): string {
      for (const line of finalOutput.trim().split('\n').reverse()) {
        if (!line.trim()) continue;
        const event = parseCopilotEvent(line);
        if (
          event?.type === 'assistant.message' &&
          typeof event.data?.content === 'string' &&
          event.data.content.trim()
        ) {
          return event.data.content;
        }
      }
      return finalOutput;
    },

    extractUsage(finalOutput: string): AgentUsage | null {
      // No input/cache token counts anywhere in the stream — sum the
      // per-message outputTokens so at least output volume is tracked.
      let summed = 0;
      let sawMessage = false;
      for (const line of finalOutput.trim().split('\n')) {
        if (!line.trim()) continue;
        const event = parseCopilotEvent(line);
        if (event?.type === 'assistant.message' && typeof event.data?.outputTokens === 'number') {
          summed += event.data.outputTokens;
          sawMessage = true;
        }
      }
      if (!sawMessage) return null;
      return { inputTokens: 0, outputTokens: summed, cacheReadTokens: 0, cacheWriteTokens: 0 };
    },

    // The copilot stream reports no dollar cost — copilot spend is invisible to --budget.
    extractCostUsd(): number | null {
      return null;
    },

    isUsageLimitError(text: string): boolean {
      return isSharedUsageLimitError(text) || COPILOT_USAGE_LIMIT_RE.test(text);
    },

    isInfraError(text: string): boolean {
      return isSharedInfraError(text) || COPILOT_INFRA_ERROR_RE.test(text);
    },

    // The copilot stream reports no input-token counts anywhere, so no context
    // figure — peak or cumulative — can be derived from it.
    parseTurnContextTokens(): number | null {
      return null;
    },
  };
}
