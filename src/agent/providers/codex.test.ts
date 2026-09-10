import { describe, expect, it } from 'vitest';

import { codexRolloutContextPeak, createCodexProvider, peakFromRolloutLines } from './codex.js';

// Lines captured verbatim from a live `codex exec ... --json` run (codex-cli 0.142.2).
const THREAD_STARTED_LINE = '{"type":"thread.started","thread_id":"019f421b-2833-7510-b488-f791e9f77d1d"}';
const TURN_STARTED_LINE = '{"type":"turn.started"}';
const AGENT_MESSAGE_INTRO_LINE =
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll create the file with the requested shell command and verify its contents."}}';
const COMMAND_STARTED_LINE =
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \\"printf hi > hi.txt\\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}';
const COMMAND_COMPLETED_LINE =
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \\"printf hi > hi.txt\\"","aggregated_output":"","exit_code":0,"status":"completed"}}';
const AGENT_MESSAGE_FINAL_LINE = '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done"}}';
const TURN_COMPLETED_LINE =
  '{"type":"turn.completed","usage":{"input_tokens":33086,"cached_input_tokens":32256,"output_tokens":116,"reasoning_output_tokens":0}}';

const provider = createCodexProvider();

describe('codex buildArgs', () => {
  it('builds the workspace-write exec invocation with json output', () => {
    expect(provider.buildArgs({ prompt: 'do it', model: 'gpt-5.5', effort: null, cwd: '/w' })).toEqual([
      'exec',
      'do it',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy=never',
      '--json',
      '-m',
      'gpt-5.5',
    ]);
  });

  it('omits the model flag for null and for loop\'s "auto" sentinel', () => {
    expect(provider.buildArgs({ prompt: 'p', model: null, effort: null, cwd: '/w' })).not.toContain('-m');
    expect(provider.buildArgs({ prompt: 'p', model: 'auto', effort: null, cwd: '/w' })).not.toContain('-m');
  });

  it('passes model_reasoning_effort via -c when effort is set', () => {
    expect(provider.buildArgs({ prompt: 'p', model: null, effort: 'high', cwd: '/w' })).toEqual([
      'exec',
      'p',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy=never',
      '--json',
      '-c',
      'model_reasoning_effort="high"',
    ]);
  });

  it('omits model_reasoning_effort when effort is null', () => {
    expect(provider.buildArgs({ prompt: 'p', model: null, effort: null, cwd: '/w' })).not.toContain(
      'model_reasoning_effort',
    );
  });
});

describe('codex parseLine', () => {
  it('maps thread.started to session-start (codex reports no model)', () => {
    expect(provider.parseLine(THREAD_STARTED_LINE)).toEqual({ type: 'session-start', model: '' });
  });

  it('ignores turn.started', () => {
    expect(provider.parseLine(TURN_STARTED_LINE)).toBeNull();
  });

  it('maps agent_message items to consolidated assistant-text', () => {
    expect(provider.parseLine(AGENT_MESSAGE_FINAL_LINE)).toEqual({
      type: 'assistant-text',
      text: 'done',
      consolidated: true,
    });
  });

  it('maps command executions to tool-call start/result with exit code and exec evidence', () => {
    expect(provider.parseLine(COMMAND_STARTED_LINE)).toEqual({
      type: 'tool-call-start',
      summary: 'shell: /bin/zsh -lc "printf hi > hi.txt"',
      toolName: 'command_execution',
      toolInput: { command: '/bin/zsh -lc "printf hi > hi.txt"' },
    });
    expect(provider.parseLine(COMMAND_COMPLETED_LINE)).toEqual({
      type: 'tool-call-result',
      summary: 'shell: /bin/zsh -lc "printf hi > hi.txt"',
      result: 'exit 0',
      exec: { command: '/bin/zsh -lc "printf hi > hi.txt"', ok: true },
    });
  });

  it('marks failed command executions as exec not-ok', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_9', type: 'command_execution', command: 'pnpm test', exit_code: 1, status: 'completed' },
    });
    expect(provider.parseLine(line)).toMatchObject({
      type: 'tool-call-result',
      result: 'exit 1',
      exec: { command: 'pnpm test', ok: false },
    });
  });

  it('maps reasoning items to completed thinking blocks (documented shape)', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_3', type: 'reasoning', text: 'Considering the layout.' },
    });
    expect(provider.parseLine(line)).toEqual({
      type: 'thinking-text',
      text: 'Considering the layout.',
      completed: true,
    });
  });

  it('maps turn.completed / turn.failed to result events (turn.failed uses constructed fixture — not emitted in live smoke runs)', () => {
    expect(provider.parseLine(TURN_COMPLETED_LINE)).toEqual({ type: 'result', ok: true, durationMs: 0, text: null });
    expect(provider.parseLine('{"type":"turn.failed","error":{"message":"boom"}}')).toEqual({
      type: 'result',
      ok: false,
      durationMs: 0,
      text: 'boom',
    });
  });

  it('maps file_change items to an edit summary without exec evidence', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_4', type: 'file_change', status: 'completed', changes: [{ path: 'src/a.ts', kind: 'edit' }] },
    });
    expect(provider.parseLine(line)).toEqual({ type: 'tool-call-result', summary: 'edit: src/a.ts', result: null });
  });

  it('carries file_change paths as tool input on start (evidence tracker path rules)', () => {
    const line = JSON.stringify({
      type: 'item.started',
      item: { id: 'item_4', type: 'file_change', status: 'in_progress', changes: [{ path: 'src/a.ts', kind: 'edit' }] },
    });
    expect(provider.parseLine(line)).toEqual({
      type: 'tool-call-start',
      summary: 'edit: src/a.ts',
      toolName: 'file_change',
      toolInput: { paths: ['src/a.ts'] },
    });
  });

  it('surfaces unparseable lines as raw-line events', () => {
    expect(provider.parseLine('some banner text')).toEqual({ type: 'raw-line', text: 'some banner text' });
  });
});

describe('codex extractResultText / extractUsage', () => {
  const stream = [
    THREAD_STARTED_LINE,
    TURN_STARTED_LINE,
    AGENT_MESSAGE_INTRO_LINE,
    COMMAND_STARTED_LINE,
    COMMAND_COMPLETED_LINE,
    AGENT_MESSAGE_FINAL_LINE,
    TURN_COMPLETED_LINE,
  ].join('\n');

  it('returns the last agent_message text', () => {
    expect(provider.extractResultText(stream)).toBe('done');
  });

  it('falls back to the whole output when no agent_message exists', () => {
    expect(provider.extractResultText('plain output')).toBe('plain output');
  });

  it('subtracts cached tokens from input and maps cached to cache-read', () => {
    expect(provider.extractUsage(stream)).toEqual({
      inputTokens: 33086 - 32256,
      outputTokens: 116,
      cacheReadTokens: 32256,
      cacheWriteTokens: 0,
    });
  });

  it('returns null when no turn.completed event exists', () => {
    expect(provider.extractUsage(THREAD_STARTED_LINE)).toBeNull();
  });
});

describe('codex isUsageLimitError', () => {
  it('matches shared and codex-specific limit phrasings', () => {
    expect(provider.isUsageLimitError('usage_limit_reached')).toBe(true);
    expect(provider.isUsageLimitError('insufficient_quota')).toBe(true);
    expect(provider.isUsageLimitError('429 Too Many Requests')).toBe(true);
    expect(provider.isUsageLimitError('all fine')).toBe(false);
  });
});

describe('context reporting', () => {
  const tokenCount = (lastInput: number, cumulative: number) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: cumulative },
          last_token_usage: { input_tokens: lastInput, cached_input_tokens: lastInput - 500 },
          model_context_window: 258_400,
        },
      },
    });

  it('takes the high-water mark across compactions, not the final or cumulative figure', () => {
    // 80% of the window, compacted down, then back to 70%: the peak is the 80%.
    const rollout = [
      tokenCount(20_000, 20_000),
      tokenCount(206_720, 226_720),
      tokenCount(25_840, 252_560),
      tokenCount(180_880, 433_440),
    ].join('\n');
    expect(peakFromRolloutLines(rollout)).toBe(206_720);
  });

  it('reads occupancy from last_token_usage alone, never summing the cached portion', () => {
    // codex's input_tokens already includes cached_input_tokens; adding them
    // double-counts and can exceed the window.
    expect(peakFromRolloutLines(tokenCount(94_414, 797_365))).toBe(94_414);
  });

  it('returns null for a rollout with no token_count records', () => {
    expect(peakFromRolloutLines('{"type":"event_msg","payload":{"type":"agent_message"}}')).toBeNull();
  });

  it('ignores an unparseable session id rather than walking the filesystem', () => {
    expect(codexRolloutContextPeak('../../etc/passwd')).toBeNull();
  });

  it('claims no measured context peak, because codex reports cumulative turn input', () => {
    const provider = createCodexProvider();
    // A real session: one turn.completed for the whole run, 797,365 input
    // tokens against a context window of roughly 260,000. Read as per-request
    // occupancy this yields a "peak context" in the millions — a token total
    // wearing a context window's name.
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 797_365, cached_input_tokens: 713_856, output_tokens: 4_915 },
    });
    expect(provider.parseTurnContextTokens?.(line) ?? null).toBeNull();
  });
});

describe('session resume', () => {
  it('extracts thread_id and resumes via `exec resume <id> <prompt>`', () => {
    const provider = createCodexProvider();
    expect(provider.extractSessionId('{"type":"thread.started","thread_id":"t-42"}')).toBe('t-42');
    expect(provider.extractSessionId('nothing')).toBeNull();

    const args = provider.buildResumeArgs({
      prompt: 'continue',
      model: 'auto',
      effort: null,
      cwd: '/repo',
      sessionId: 't-42',
    });
    expect(args!.slice(0, 4)).toEqual(['exec', 'resume', 't-42', 'continue']);
    expect(args).toContain('--json');
  });

  it('carries the sandbox policy as -c, because `exec resume` rejects --sandbox', () => {
    const provider = createCodexProvider();
    const args = provider.buildResumeArgs({
      prompt: 'continue',
      model: 'auto',
      effort: null,
      cwd: '/repo',
      sessionId: 't-42',
    });
    // `codex exec resume` accepts no --sandbox flag; passing one makes the CLI
    // exit before the session starts, which turns every usage-limit retry into
    // an agent failure.
    expect(args).not.toContain('--sandbox');
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).toContain('approval_policy=never');
  });
});
