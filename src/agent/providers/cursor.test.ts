import { describe, expect, it } from 'vitest';

import { createCursorProvider } from './cursor.js';

// Fixtures are hand-authored to match Cursor's documented stream-json shape.
// Claude/Codex tests below use lines captured from live smoke runs; Cursor
// remains the reference provider and these events are synthetic but
// structurally faithful — not re-captured from a full agent session here.
const provider = createCursorProvider();

describe('cursor buildArgs', () => {
  it('builds the headless stream-json invocation with workspace and model', () => {
    const args = provider.buildArgs({ prompt: 'do the thing', model: 'auto', effort: null, cwd: '/work/root' });
    expect(args).toEqual([
      'agent',
      '-p',
      '--trust',
      '--force',
      '--approve-mcps',
      '--workspace',
      '/work/root',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--model',
      'auto',
      'do the thing',
    ]);
  });

  it('omits the model flag when model is null', () => {
    const args = provider.buildArgs({ prompt: 'p', model: null, effort: null, cwd: '/w' });
    expect(args).not.toContain('--model');
    expect(args[args.length - 1]).toBe('p');
  });
});

describe('cursor parseLine', () => {
  it('maps system init to session-start', () => {
    expect(provider.parseLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'gpt-5.5' }))).toEqual({
      type: 'session-start',
      model: 'gpt-5.5',
    });
  });

  it('maps assistant deltas and consolidated messages', () => {
    const delta = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Implement' }] },
    });
    const full = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Implementing now.' }] },
      model_call_id: 'call-1',
    });
    expect(provider.parseLine(delta)).toEqual({ type: 'assistant-text', text: 'Implement' });
    expect(provider.parseLine(full)).toEqual({ type: 'assistant-text', text: 'Implementing now.', consolidated: true });
  });

  it('maps thinking deltas and completion', () => {
    expect(provider.parseLine(JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'hmm' }))).toEqual({
      type: 'thinking-text',
      text: 'hmm',
    });
    expect(provider.parseLine(JSON.stringify({ type: 'thinking', subtype: 'completed' }))).toEqual({
      type: 'thinking-text',
      text: '',
      completed: true,
    });
  });

  it('summarizes shell tool calls with description and command, carrying tool identity', () => {
    const started = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      tool_call: { shellToolCall: { args: { command: 'pnpm test', description: 'run tests' } } },
    });
    expect(provider.parseLine(started)).toEqual({
      type: 'tool-call-start',
      summary: 'shell (run tests): pnpm test',
      toolName: 'shell',
      toolInput: { command: 'pnpm test', description: 'run tests' },
    });
  });

  it('emits exec evidence on completed shell calls, honouring result.error', () => {
    const completed = (result: unknown): string =>
      JSON.stringify({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: { shellToolCall: { args: { command: 'pnpm test' }, result } },
      });
    expect(provider.parseLine(completed({ success: { exitCode: 0 } }))).toMatchObject({
      type: 'tool-call-result',
      exec: { command: 'pnpm test', ok: true },
    });
    expect(provider.parseLine(completed({ error: { message: 'boom' } }))).toMatchObject({
      type: 'tool-call-result',
      exec: { command: 'pnpm test', ok: false },
    });
    // Non-shell completions carry no exec evidence.
    const edit = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      tool_call: { editToolCall: { args: { path: '/repo/a.ts' }, result: { success: {} } } },
    });
    expect(provider.parseLine(edit)).not.toHaveProperty('exec');
  });

  it('summarizes edit tool completion with line counts', () => {
    const completed = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      tool_call: {
        editToolCall: {
          args: { path: '/repo/src/transitions.ts' },
          result: { success: { path: '/repo/src/transitions.ts', linesAdded: 3, linesRemoved: 1 } },
        },
      },
    });
    expect(provider.parseLine(completed)).toEqual({
      type: 'tool-call-result',
      summary: 'edit: /repo/src/transitions.ts',
      result: '+3 -1',
    });
  });

  it('maps the result event with duration and text', () => {
    expect(
      provider.parseLine(JSON.stringify({ type: 'result', is_error: false, duration_ms: 1000, result: 'ok' })),
    ).toEqual({ type: 'result', ok: true, durationMs: 1000, text: 'ok' });
    expect(provider.parseLine(JSON.stringify({ type: 'result', is_error: true, duration_ms: 5 }))).toEqual({
      type: 'result',
      ok: false,
      durationMs: 5,
      text: null,
    });
  });

  it('surfaces unparseable lines as raw-line events', () => {
    expect(provider.parseLine('not json at all')).toEqual({ type: 'raw-line', text: 'not json at all' });
  });
});

describe('cursor extractResultText / extractUsage', () => {
  const stream = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
    JSON.stringify({
      type: 'result',
      is_error: false,
      duration_ms: 2000,
      result: 'Final answer.\n\n## Loop handoff\nnote',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 10 },
    }),
  ].join('\n');

  it('returns the result event text', () => {
    expect(provider.extractResultText(stream)).toContain('Final answer.');
  });

  it('falls back to the whole output when no result event exists', () => {
    expect(provider.extractResultText('plain output')).toBe('plain output');
  });

  it('extracts camelCase usage fields', () => {
    expect(provider.extractUsage(stream)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5000,
      cacheWriteTokens: 10,
    });
  });

  it('returns null usage when the result event has none', () => {
    expect(provider.extractUsage(JSON.stringify({ type: 'result', is_error: false }))).toBeNull();
  });
});

describe('cursor isUsageLimitError', () => {
  it('matches usage-limit phrasings without matching timestamps', () => {
    expect(provider.isUsageLimitError("You've hit your usage limit")).toBe(true);
    expect(provider.isUsageLimitError('rate_limit_exceeded')).toBe(true);
    expect(provider.isUsageLimitError('"status": 429')).toBe(true);
    expect(provider.isUsageLimitError('executionTime: 742934ms')).toBe(false);
  });
});

describe('session resume', () => {
  it('extracts the chat id and rebuilds args with --resume', () => {
    const provider = createCursorProvider();
    expect(provider.extractSessionId('{"type":"system","subtype":"init","chatId":"c-7"}')).toBe('c-7');
    expect(provider.extractSessionId('{"session_id":"s-8"}')).toBe('s-8');
    expect(provider.extractSessionId('none')).toBeNull();

    const args = provider.buildResumeArgs({
      prompt: 'continue',
      model: null,
      effort: null,
      cwd: '/repo',
      sessionId: 'c-7',
    });
    expect(args!.join(' ')).toContain('--resume c-7');
    expect(args![args!.length - 1]).toBe('continue');
  });
});
