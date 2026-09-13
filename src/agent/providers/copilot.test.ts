import { describe, expect, it } from 'vitest';

import { COPILOT_DENIED_REMOTE_TOOLS, createCopilotProvider } from './copilot.js';

// Representative lines matching the JSONL shapes probed against copilot 1.0.71
// (see the copilot-provider spec): every event is {type, data, id, timestamp,
// parentId, ephemeral?} except the terminal `result`, whose fields are top-level.
const REASONING_LINE = JSON.stringify({
  type: 'assistant.reasoning',
  data: { content: 'Considering the multiply issue.' },
  id: 'evt_1',
  timestamp: 1721300000001,
  parentId: null,
});

const MESSAGE_LINE = JSON.stringify({
  type: 'assistant.message',
  data: { content: 'Added multiply with tests.', outputTokens: 42 },
  id: 'evt_2',
  timestamp: 1721300000002,
  parentId: null,
});

const MESSAGE_DELTA_LINE = JSON.stringify({
  type: 'assistant.message_delta',
  data: { content: 'Added' },
  id: 'evt_2',
  timestamp: 1721300000002,
  parentId: null,
  ephemeral: true,
});

const SHELL_START_LINE = JSON.stringify({
  type: 'tool.execution_start',
  data: { toolCallId: 'call_1', toolName: 'bash', arguments: { command: 'node --test' } },
  id: 'evt_3',
  timestamp: 1721300000003,
  parentId: null,
});

const SHELL_OK_LINE = JSON.stringify({
  type: 'tool.execution_complete',
  data: { toolCallId: 'call_1', success: true, result: 'tests 3 pass 3' },
  id: 'evt_4',
  timestamp: 1721300000004,
  parentId: null,
});

const CREATE_START_LINE = JSON.stringify({
  type: 'tool.execution_start',
  data: { toolCallId: 'call_2', toolName: 'create', arguments: { path: '/tmp/sandbox/multiply.js' } },
  id: 'evt_5',
  timestamp: 1721300000005,
  parentId: null,
});

const CREATE_COMPLETE_LINE = JSON.stringify({
  type: 'tool.execution_complete',
  data: { toolCallId: 'call_2', success: true, result: 'created' },
  id: 'evt_6',
  timestamp: 1721300000006,
  parentId: null,
});

const RESULT_LINE = JSON.stringify({
  type: 'result',
  sessionId: 'sess_1',
  exitCode: 0,
  usage: { premiumRequests: 1, totalApiDurationMs: 5200, sessionDurationMs: 9100, codeChanges: { files: 2 } },
});

describe('copilot buildArgs', () => {
  const provider = createCopilotProvider();

  it('builds the non-interactive JSONL invocation with every remote-action deny pattern', () => {
    const args = provider.buildArgs({ prompt: 'do it', model: null, effort: null, cwd: '/w' });
    expect(args.slice(0, 2)).toEqual(['-p', 'do it']);
    for (const flag of [
      '--allow-all-tools',
      '--allow-all-paths',
      '--no-ask-user',
      '--no-color',
      '--no-auto-update',
      '--no-remote-export',
    ]) {
      expect(args).toContain(flag);
    }
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    for (const denied of COPILOT_DENIED_REMOTE_TOOLS) {
      const at = args.indexOf(denied);
      expect(at).toBeGreaterThan(-1);
      expect(args[at - 1]).toBe('--deny-tool');
    }
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });

  it('passes model and effort through, and treats "auto" as the CLI default', () => {
    const args = provider.buildArgs({ prompt: 'p', model: 'claude-sonnet-5', effort: 'high', cwd: '/w' });
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(provider.buildArgs({ prompt: 'p', model: 'auto', effort: null, cwd: '/w' })).not.toContain('--model');
  });
});

describe('copilot parseLine', () => {
  it('maps consolidated messages to consolidated assistant-text and reasoning to completed thinking', () => {
    const provider = createCopilotProvider();
    expect(provider.parseLine(MESSAGE_LINE)).toEqual({
      type: 'assistant-text',
      text: 'Added multiply with tests.',
      consolidated: true,
    });
    expect(provider.parseLine(REASONING_LINE)).toEqual({
      type: 'thinking-text',
      text: 'Considering the multiply issue.',
      completed: true,
    });
  });

  it('ignores ephemeral deltas, turn markers, and session housekeeping', () => {
    const provider = createCopilotProvider();
    expect(provider.parseLine(MESSAGE_DELTA_LINE)).toBeNull();
    expect(provider.parseLine(JSON.stringify({ type: 'assistant.turn_start', data: {} }))).toBeNull();
    expect(provider.parseLine(JSON.stringify({ type: 'assistant.turn_end', data: {} }))).toBeNull();
    expect(provider.parseLine(JSON.stringify({ type: 'assistant.idle', data: {} }))).toBeNull();
    expect(provider.parseLine(JSON.stringify({ type: 'session.start', data: {} }))).toBeNull();
    expect(provider.parseLine(JSON.stringify({ type: 'mcp.server_start', data: {} }))).toBeNull();
  });

  it('maps shell start+complete to tool-call events with exec evidence', () => {
    const provider = createCopilotProvider();
    expect(provider.parseLine(SHELL_START_LINE)).toEqual({
      type: 'tool-call-start',
      summary: 'shell: node --test',
      toolName: 'bash',
      toolInput: { command: 'node --test' },
    });
    expect(provider.parseLine(SHELL_OK_LINE)).toEqual({
      type: 'tool-call-result',
      summary: 'shell: node --test',
      result: null,
      exec: { command: 'node --test', ok: true },
    });
  });

  it('maps failed completions to a failure result and exec not-ok', () => {
    const provider = createCopilotProvider();
    provider.parseLine(SHELL_START_LINE);
    const failed = JSON.stringify({
      type: 'tool.execution_complete',
      data: { toolCallId: 'call_1', success: false, result: 'boom' },
    });
    expect(provider.parseLine(failed)).toEqual({
      type: 'tool-call-result',
      summary: 'shell: node --test',
      result: 'failed: boom',
      exec: { command: 'node --test', ok: false },
    });
  });

  it('emits no exec evidence for non-shell tools (create/edit)', () => {
    const provider = createCopilotProvider();
    expect(provider.parseLine(CREATE_START_LINE)).toEqual({
      type: 'tool-call-start',
      summary: 'create: /tmp/sandbox/multiply.js',
      toolName: 'create',
      toolInput: { path: '/tmp/sandbox/multiply.js' },
    });
    expect(provider.parseLine(CREATE_COMPLETE_LINE)).not.toHaveProperty('exec');
  });

  it('maps the top-level terminal result, carrying the last assistant message as text', () => {
    const provider = createCopilotProvider();
    provider.parseLine(MESSAGE_LINE);
    expect(provider.parseLine(RESULT_LINE)).toEqual({
      type: 'result',
      ok: true,
      durationMs: 9100,
      text: 'Added multiply with tests.',
    });
  });

  it('maps non-zero exit codes to a failed result, surfacing the session error text', () => {
    const provider = createCopilotProvider();
    provider.parseLine(
      JSON.stringify({ type: 'session.error', data: { message: 'premium request limit exceeded' } }),
    );
    const failed = JSON.stringify({ type: 'result', sessionId: 'sess_1', exitCode: 1, usage: {} });
    expect(provider.parseLine(failed)).toEqual({
      type: 'result',
      ok: false,
      durationMs: 0,
      text: 'premium request limit exceeded',
    });
  });

  it('surfaces session.error as a raw line', () => {
    const provider = createCopilotProvider();
    expect(provider.parseLine(JSON.stringify({ type: 'session.error', data: { message: 'no auth' } }))).toEqual({
      type: 'raw-line',
      text: 'copilot error: no auth',
    });
  });

  it('surfaces unparseable lines as raw-line events', () => {
    expect(createCopilotProvider().parseLine('some banner')).toEqual({ type: 'raw-line', text: 'some banner' });
  });
});

describe('copilot extractResultText / extractUsage / extractCostUsd', () => {
  const stream = [REASONING_LINE, SHELL_START_LINE, SHELL_OK_LINE, MESSAGE_LINE, RESULT_LINE].join('\n');
  const provider = createCopilotProvider();

  it('returns the last non-empty assistant message', () => {
    expect(provider.extractResultText(stream)).toBe('Added multiply with tests.');
  });

  it('sums per-message outputTokens (the stream reports no input tokens)', () => {
    const twoMessages = [
      MESSAGE_LINE,
      JSON.stringify({ type: 'assistant.message', data: { content: 'More.', outputTokens: 8 } }),
      RESULT_LINE,
    ].join('\n');
    expect(provider.extractUsage(twoMessages)).toEqual({
      inputTokens: 0,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(provider.extractUsage(RESULT_LINE)).toBeNull();
  });

  it('reports no dollar cost (copilot spend is invisible to --budget)', () => {
    expect(provider.extractCostUsd(stream)).toBeNull();
  });
});

describe('copilot isUsageLimitError', () => {
  const provider = createCopilotProvider();

  it('matches copilot-specific quota phrasings plus the shared detector', () => {
    expect(provider.isUsageLimitError('you have exhausted your premium request allowance limit')).toBe(true);
    expect(provider.isUsageLimitError('premium request limit exceeded')).toBe(true);
    expect(provider.isUsageLimitError('out of AI credits')).toBe(true);
    expect(provider.isUsageLimitError('quota reached for this billing cycle')).toBe(true);
    expect(provider.isUsageLimitError('rate limit exceeded')).toBe(true);
    expect(provider.isUsageLimitError('everything is fine')).toBe(false);
  });
});

describe('session resume', () => {
  it('extracts sessionId from the result event and appends --resume=<id>', () => {
    const provider = createCopilotProvider();
    expect(provider.extractSessionId('{"type":"result","sessionId":"cp-1","exitCode":0}')).toBe('cp-1');
    expect(provider.extractSessionId('none')).toBeNull();

    const args = provider.buildResumeArgs({
      prompt: 'continue',
      model: 'auto',
      effort: null,
      cwd: '/repo',
      sessionId: 'cp-1',
    });
    expect(args).toContain('--resume=cp-1');
    expect(args!.slice(0, 2)).toEqual(['-p', 'continue']);
  });
});
