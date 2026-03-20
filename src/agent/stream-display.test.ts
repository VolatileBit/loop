import { describe, expect, it } from 'vitest';

import { AgentStreamDisplay, type AgentStreamDisplayOptions } from './stream-display.js';
import { contentWidth } from '../logs/output-prefix.js';
import type { CanonicalAgentEvent } from './providers/types.js';

function render(events: CanonicalAgentEvent[], opts?: Omit<AgentStreamDisplayOptions, 'write'>): string {
  let out = '';
  const display = new AgentStreamDisplay({
    ...opts,
    write: (chunk) => {
      out += chunk;
    },
  });
  for (const event of events) display.handleEvent(event);
  display.flush();
  return out;
}

function delta(text: string): CanonicalAgentEvent {
  return { type: 'assistant-text', text };
}

function consolidated(text: string): CanonicalAgentEvent {
  return { type: 'assistant-text', text, consolidated: true };
}

/** The label a real pipeline stage passes. */
const LABEL = 'PRD-011/issue-06-review-round-6';

describe('AgentStreamDisplay assistant text', () => {
  it('renders streamed token deltas as a single clean line, not one token per line', () => {
    const out = render([
      delta('Implement'),
      delta('ing'),
      delta(' TDD'),
      delta(' at the seam.'),
      consolidated('Implementing TDD at the seam.'),
    ]);

    expect(out).toBe('[loop] │ Implementing TDD at the seam.\n');
  });

  it('renders a final message that never gets a consolidated event (deltas only)', () => {
    const out = render([
      delta('All'),
      delta(' done.'),
      { type: 'result', ok: true, durationMs: 1000, text: 'ok' },
    ]);

    expect(out).toBe('[loop] │ All done.\n[loop] │ finished (1s): ok\n');
  });
});

describe('AgentStreamDisplay gutter rail', () => {
  it('hangs continuation lines under the prefix, so a message reads as one block', () => {
    const out = render([consolidated('First line.\nSecond line.\nThird line.')], { label: LABEL });
    const lines = out.split('\n').filter(Boolean);

    expect(lines[0]).toBe('[06|review-6] │ First line.');
    // The gutter column is identical on every line — that is what makes a rail.
    expect(new Set(lines.map((line) => line.indexOf('│'))).size).toBe(1);
    const continuation = ' '.repeat('[06|review-6]'.length);
    expect(lines[1]).toBe(`${continuation} │ Second line.`);
    expect(lines[2]).toBe(`${continuation} │ Third line.`);
  });

  it('keeps the rail unbroken across a blank line inside a message', () => {
    const out = render([consolidated('Para one.\n\nPara two.')], { label: LABEL });
    const lines = out.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(3);
    expect(lines[1]!.trim()).toBe('│');
  });

  it('marks every agent-side line, whatever kind it is', () => {
    const out = render(
      [
        { type: 'session-start', model: 'opus-5' },
        { type: 'tool-call-start', summary: 'read: /repo/a.ts' },
        { type: 'tool-call-result', summary: 'read: /repo/a.ts', result: null },
        { type: 'raw-line', text: 'stray output' },
        { type: 'result', ok: true, durationMs: 1000, text: 'ok' },
      ],
      { label: LABEL },
    );
    for (const line of out.split('\n').filter(Boolean)) {
      expect(line).toContain('│');
    }
  });
});

describe('AgentStreamDisplay contextual label', () => {
  it('labels both voices with the same issue and stage', () => {
    const out = render(
      [
        { type: 'thinking-text', text: 'Considering approach' },
        { type: 'thinking-text', text: '', completed: true },
        delta('Implementing.'),
        consolidated('Implementing.'),
      ],
      { label: 'PRD-011/issue-01-verify-fix-1' },
    );

    expect(out).toContain('[01|verify-fix-1] │ Considering approach\n');
    expect(out).toContain('[01|verify-fix-1] │ Implementing.\n');
  });

  it('compacts every stage form the pipeline emits', () => {
    const stageOf = (label: string): string =>
      render([consolidated('x')], { label }).match(/\[(.*?)]/)![1]!;
    expect(stageOf('P/issue-02-implement')).toBe('02|implement');
    expect(stageOf('P/issue-02-verify')).toBe('02|verify');
    // Only the review *round* compacts; the fix stages stay explicit, because
    // "verify-1" and "fix-1" name different things than they are.
    expect(stageOf('P/issue-02-verify-fix-3')).toBe('02|verify-fix-3');
    expect(stageOf('P/issue-02-review-round-6')).toBe('02|review-6');
    expect(stageOf('P/issue-02-review-fix-2')).toBe('02|review-fix-2');
  });

  it('falls back to a plain [loop] prefix when no label is given', () => {
    const out = render([delta('Hi'), consolidated('Hi')]);
    expect(out).toBe('[loop] │ Hi\n');
  });
});

describe('AgentStreamDisplay thinking', () => {
  it('renders thinking deltas as a single block when enabled', () => {
    const out = render([
      { type: 'thinking-text', text: 'Most of the work' },
      { type: 'thinking-text', text: ' is already done.' },
      { type: 'thinking-text', text: '', completed: true },
    ]);

    expect(out).toBe('[loop] │ Most of the work is already done.\n');
  });

  it('renders a whole-block thinking event (coarse providers) in one flush', () => {
    const out = render([{ type: 'thinking-text', text: 'Full reasoning block.', completed: true }]);
    expect(out).toBe('[loop] │ Full reasoning block.\n');
  });

  it('omits thinking when disabled', () => {
    const out = render(
      [
        { type: 'thinking-text', text: 'private reasoning' },
        { type: 'thinking-text', text: '', completed: true },
      ],
      { showThinking: false },
    );

    expect(out).toBe('');
  });
});

describe('AgentStreamDisplay tool calls', () => {
  it('shows tool results on completion', () => {
    const out = render([
      { type: 'tool-call-result', summary: 'edit: /repo/src/transitions.ts', result: '+3 -1' },
    ]);

    expect(out).toBe('[loop] │ ✓ edit: /repo/src/transitions.ts (+3 -1)\n');
  });

  it('omits the parenthetical when the tool result is null', () => {
    const out = render([{ type: 'tool-call-result', summary: 'read: /repo/a.ts', result: null }]);
    expect(out).toBe('[loop] │ ✓ read: /repo/a.ts\n');
  });

  it('flushes pending assistant text before a tool call', () => {
    const out = render([
      delta('Reading the file.'),
      consolidated('Reading the file.'),
      { type: 'tool-call-start', summary: 'read: /repo/a.ts' },
    ]);

    expect(out).toBe('[loop] │ Reading the file.\n[loop] │ → read: /repo/a.ts\n');
  });
});

describe('AgentStreamDisplay session and raw lines', () => {
  it('announces the session with the provider model when reported', () => {
    expect(render([{ type: 'session-start', model: 'gpt-5.5' }])).toBe(
      '[loop] │ session started (gpt-5.5)\n',
    );
  });

  it('falls back to the requested model when the provider reports none', () => {
    expect(render([{ type: 'session-start', model: '' }], { fallbackModel: 'gpt-5.6-sol' })).toBe(
      '[loop] │ session started (gpt-5.6-sol)\n',
    );
  });

  it('reports an unknown model only when neither the provider nor caller supplies one', () => {
    expect(render([{ type: 'session-start', model: '' }])).toBe(
      '[loop] │ session started (unknown model)\n',
    );
  });

  it('prints raw lines with the agent prefix, flushing buffered text first', () => {
    const out = render([delta('Working'), { type: 'raw-line', text: 'stray output' }]);
    expect(out).toBe('[loop] │ Working\n[loop] │ stray output\n');
  });

  it('reports unknown duration when the provider gives none', () => {
    const out = render([{ type: 'result', ok: false, durationMs: 0, text: null }]);
    expect(out).toBe('[loop] │ failed (unknown duration)\n');
  });
});

describe('AgentStreamDisplay suppressed echo', () => {
  it('emits nothing when disabled, even for results', () => {
    const out = render(
      [
        { type: 'session-start', model: 'm' },
        delta('text'),
        { type: 'tool-call-start', summary: 'shell: ls' },
        { type: 'result', ok: true, durationMs: 5, text: 'ok' },
      ],
      { enabled: false },
    );
    expect(out).toBe('');
  });
});

describe('AgentStreamDisplay long lines', () => {
  const LONG = `Here is a very long single line of agent prose that keeps going well past any sensible terminal width ${'and onwards '.repeat(20)}until it finally stops.`;

  /** Every line's budget: the full width less the invocation log's `HH:MM:SS `. */
  const BUDGET = contentWidth('');

  it('wraps a long line so the terminal cannot break the rail', () => {
    const out = render([consolidated(LONG)], { label: LABEL });
    const lines = out.split('\n').filter(Boolean);

    expect(lines.length).toBeGreaterThan(1);
    // The whole point: the terminal never sees a line long enough to wrap
    // itself, which would put the overflow at column 0 with no gutter.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(BUDGET);
    for (const line of lines) expect(line).toContain('│');
  });

  it('keeps every wrapped line in the gutter column', () => {
    const lines = render([consolidated(LONG)], { label: LABEL }).split('\n').filter(Boolean);
    expect(new Set(lines.map((line) => line.indexOf('│'))).size).toBe(1);
  });

  it('loses no words to wrapping', () => {
    const lines = render([consolidated(LONG)], { label: LABEL }).split('\n').filter(Boolean);
    const text = lines.map((line) => line.slice(line.indexOf('│') + 1).trim()).join(' ');
    expect(text).toBe(LONG);
  });

  it('cuts a long tool summary to one line rather than wrapping it', () => {
    const lines = render([{ type: 'tool-call-start', summary: 'x'.repeat(400) }], { label: LABEL })
      .split('\n')
      .filter(Boolean);

    // Hundreds of these per stage: four wrapped lines each would bury every
    // message between them.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/…$/);
  });

  it('cuts tool lines at the same column prose wraps at', () => {
    const tool = render([{ type: 'tool-call-start', summary: 'x'.repeat(400) }], { label: LABEL }).trimEnd();
    const prose = render([consolidated(LONG)], { label: LABEL }).split('\n').filter(Boolean);

    // One right edge for cut lines and wrapped ones alike.
    expect(tool.length).toBe(BUDGET);
    for (const line of prose) expect(line.length).toBeLessThanOrEqual(BUDGET);
  });

  it('keeps a tool result whole, cutting the command to make room', () => {
    const line = render(
      [{ type: 'tool-call-result', summary: `shell: ${'x'.repeat(400)}`, result: 'exit 0' }],
      { label: LABEL },
    ).trimEnd();

    // An exit code says more than the last few characters of a long command.
    expect(line.endsWith('(exit 0)')).toBe(true);
    expect(line.length).toBe(BUDGET);
  });
});
