import { describe, expect, it } from 'vitest';

import { CLAUDE_DENIED_REMOTE_TOOLS, createClaudeCodeProvider } from './claude-code.js';

const DENY_ARGS = ['--disallowedTools', CLAUDE_DENIED_REMOTE_TOOLS.join(',')];

// Representative lines captured from a live `claude -p ... --output-format
// stream-json --verbose --include-partial-messages` run (claude 2.1.201),
// trimmed to the fields loop consumes.
const INIT_LINE = JSON.stringify({
  type: 'system',
  subtype: 'init',
  cwd: '/private/tmp/loop-smoke-claude',
  session_id: '72b94034-fd2e-4d35-a4a6-6ff7d7338393',
  model: 'claude-sonnet-5',
  permissionMode: 'bypassPermissions',
});

const TEXT_DELTA_LINE = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'h' } },
  session_id: '72b94034',
});

const ASSISTANT_TEXT_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    model: 'claude-sonnet-5',
    id: 'msg_011CcpjUBUaCGiAP62H8wyDU',
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
  },
});

const TOOL_USE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01HEe6swVUsP5Bk9hB2tkStr',
        name: 'Write',
        input: { file_path: '/private/tmp/loop-smoke-claude/hi.txt', content: 'hi' },
      },
    ],
  },
});

const TOOL_RESULT_LINE = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: 'toolu_01HEe6swVUsP5Bk9hB2tkStr',
        type: 'tool_result',
        content: 'File created successfully at: /private/tmp/loop-smoke-claude/hi.txt',
      },
    ],
  },
});

const RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 5070,
  num_turns: 1,
  result: 'hello',
  total_cost_usd: 0.0670658,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 10294,
    cache_read_input_tokens: 15526,
    output_tokens: 4,
  },
});

describe('claude-code buildArgs', () => {
  const provider = createClaudeCodeProvider();

  it('builds the headless stream-json invocation with the remote-action deny list', () => {
    expect(provider.buildArgs({ prompt: 'do it', model: 'sonnet-5', effort: null, cwd: '/w' })).toEqual([
      '-p',
      '--permission-mode',
      'bypassPermissions',
      ...DENY_ARGS,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      'sonnet-5',
      'do it',
    ]);
    expect(CLAUDE_DENIED_REMOTE_TOOLS).toContain('Bash(git push:*)');
    expect(CLAUDE_DENIED_REMOTE_TOOLS).toContain('Bash(gh pr create:*)');
  });

  it('omits the model flag for null and for loop\'s "auto" sentinel', () => {
    expect(provider.buildArgs({ prompt: 'p', model: null, effort: null, cwd: '/w' })).not.toContain('--model');
    expect(provider.buildArgs({ prompt: 'p', model: 'auto', effort: null, cwd: '/w' })).not.toContain('--model');
  });

  it('passes --effort when effort is set', () => {
    expect(provider.buildArgs({ prompt: 'p', model: null, effort: 'high', cwd: '/w' })).toEqual([
      '-p',
      '--permission-mode',
      'bypassPermissions',
      ...DENY_ARGS,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--effort',
      'high',
      'p',
    ]);
  });

  it('omits --effort when effort is null', () => {
    expect(provider.buildArgs({ prompt: 'p', model: null, effort: null, cwd: '/w' })).not.toContain('--effort');
  });
});

describe('claude-code parseLine', () => {
  it('maps init to session-start with the model', () => {
    const provider = createClaudeCodeProvider();
    expect(provider.parseLine(INIT_LINE)).toEqual({ type: 'session-start', model: 'claude-sonnet-5' });
  });

  it('maps text deltas to incremental assistant-text', () => {
    const provider = createClaudeCodeProvider();
    expect(provider.parseLine(TEXT_DELTA_LINE)).toEqual({ type: 'assistant-text', text: 'h' });
  });

  it('maps complete assistant messages to consolidated assistant-text', () => {
    const provider = createClaudeCodeProvider();
    expect(provider.parseLine(ASSISTANT_TEXT_LINE)).toEqual({
      type: 'assistant-text',
      text: 'hello',
      consolidated: true,
    });
  });

  it('maps tool_use to tool-call-start (with tool identity) and echoes the summary on the matching tool_result', () => {
    const provider = createClaudeCodeProvider();
    expect(provider.parseLine(TOOL_USE_LINE)).toEqual({
      type: 'tool-call-start',
      summary: 'write: /private/tmp/loop-smoke-claude/hi.txt',
      toolName: 'Write',
      toolInput: { file_path: '/private/tmp/loop-smoke-claude/hi.txt', content: 'hi' },
    });
    // Non-shell tools carry no exec evidence.
    expect(provider.parseLine(TOOL_RESULT_LINE)).toEqual({
      type: 'tool-call-result',
      summary: 'write: /private/tmp/loop-smoke-claude/hi.txt',
      result: 'File created successfully at: /private/tmp/loop-smoke-claude/hi.txt',
    });
  });

  it('emits exec evidence for Bash tool results, honouring is_error', () => {
    const bashUse = (id: string, command: string): string =>
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
      });
    const bashResult = (id: string, isError?: boolean): string =>
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ tool_use_id: id, type: 'tool_result', content: 'out', ...(isError ? { is_error: true } : {}) }],
        },
      });

    const provider = createClaudeCodeProvider();
    provider.parseLine(bashUse('t1', 'pnpm test'));
    expect(provider.parseLine(bashResult('t1'))).toMatchObject({
      type: 'tool-call-result',
      exec: { command: 'pnpm test', ok: true },
    });

    provider.parseLine(bashUse('t2', 'pnpm test'));
    expect(provider.parseLine(bashResult('t2', true))).toMatchObject({
      type: 'tool-call-result',
      exec: { command: 'pnpm test', ok: false },
    });

    // The pending entry is consume-once: a duplicate result carries no exec.
    const again = provider.parseLine(bashResult('t1'));
    expect(again).not.toHaveProperty('exec');
  });

  it('maps thinking deltas (documented Anthropic stream shape; live-validated indirectly via smoke run, not every edge subtype)', () => {
    const provider = createClaudeCodeProvider();
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } },
    });
    expect(provider.parseLine(line)).toEqual({ type: 'thinking-text', text: 'pondering' });
  });

  it('ignores input_json_delta and lifecycle stream events', () => {
    const provider = createClaudeCodeProvider();
    const jsonDelta = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"fi' } },
    });
    const messageStart = JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } });
    const rateLimit = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
    expect(provider.parseLine(jsonDelta)).toBeNull();
    expect(provider.parseLine(messageStart)).toBeNull();
    expect(provider.parseLine(rateLimit)).toBeNull();
  });

  it('maps the terminal result event', () => {
    const provider = createClaudeCodeProvider();
    expect(provider.parseLine(RESULT_LINE)).toEqual({ type: 'result', ok: true, durationMs: 5070, text: 'hello' });
  });
});

describe('claude-code extractResultText / extractUsage', () => {
  const stream = [INIT_LINE, TEXT_DELTA_LINE, ASSISTANT_TEXT_LINE, RESULT_LINE].join('\n');
  const provider = createClaudeCodeProvider();

  it('returns the result event text', () => {
    expect(provider.extractResultText(stream)).toBe('hello');
  });

  it('maps snake_case usage fields to the canonical shape', () => {
    expect(provider.extractUsage(stream)).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 15526,
      cacheWriteTokens: 10294,
    });
  });

  it('returns null when there is no result event', () => {
    expect(provider.extractUsage(TEXT_DELTA_LINE)).toBeNull();
  });

  it('extracts the reported dollar cost (claude is the only CLI that reports one)', () => {
    expect(provider.extractCostUsd(stream)).toBeCloseTo(0.0670658);
    expect(provider.extractCostUsd(TEXT_DELTA_LINE)).toBeNull();
  });
});

describe('claude-code isUsageLimitError', () => {
  const provider = createClaudeCodeProvider();

  it('matches shared and claude-specific limit phrasings', () => {
    expect(provider.isUsageLimitError('Claude AI usage limit reached|1783529400')).toBe(true);
    expect(provider.isUsageLimitError('Your credit balance is too low')).toBe(true);
    expect(provider.isUsageLimitError('rate limit exceeded')).toBe(true);
    expect(provider.isUsageLimitError('all good here')).toBe(false);
  });
});

describe('session resume', () => {
  it('extracts session_id from the stream and rebuilds args with --resume', () => {
    const provider = createClaudeCodeProvider();
    const output = '{"type":"system","subtype":"init","session_id":"abc-123","model":"claude"}';
    expect(provider.extractSessionId(output)).toBe('abc-123');
    expect(provider.extractSessionId('no ids here')).toBeNull();

    const args = provider.buildResumeArgs({
      prompt: 'continue',
      model: 'auto',
      effort: null,
      cwd: '/repo',
      sessionId: 'abc-123',
    });
    expect(args).not.toBeNull();
    expect(args!.join(' ')).toContain('--resume abc-123');
    // The continuation prompt stays the trailing positional.
    expect(args![args!.length - 1]).toBe('continue');
  });
});
