import { afterEach, describe, expect, it } from 'vitest';

import { badge, bad, colorEnabled, cost, detail, good, setColorEnabled, worker } from './style.js';

afterEach(() => {
  setColorEnabled(null);
});

const ESC = '\u001b';

describe('style enablement', () => {
  it('is off under the suite, so console assertions never depend on a TTY', () => {
    // vitest.config.ts pins NO_COLOR for exactly this reason.
    expect(colorEnabled()).toBe(false);
    expect(bad('stopped')).toBe('stopped');
    expect(detail('log: .loop/runs/x')).toBe('log: .loop/runs/x');
  });

  it('emits codes only when enabled', () => {
    setColorEnabled(true);
    expect(good('passed')).toContain(ESC);
    expect(good('passed')).toContain('passed');
    setColorEnabled(false);
    expect(good('passed')).toBe('passed');
  });

  it('leaves empty strings alone rather than emitting a bare reset', () => {
    setColorEnabled(true);
    expect(cost('')).toBe('');
  });
});

describe('badge', () => {
  it('pads the label so the background reads as a block, not tight text', () => {
    setColorEnabled(true);
    expect(badge('APPROVED', 'good')).toContain(' APPROVED ');
  });

  it('carries meaning in the background colour, so the tone is legible unread', () => {
    setColorEnabled(true);
    const background = (text: string): string => text.match(/^\u001b\[(\d+)m/)?.[1] ?? '';
    expect(background(badge('STOPPED', 'bad'))).toBe('41');
    expect(background(badge('RULING MINOR', 'caution'))).toBe('43');
    expect(background(badge('ALL-LANDED', 'good'))).toBe('42');
    // Every tone is distinct, or the colour would carry nothing.
    const tones = ['bad', 'caution', 'good', 'info'] as const;
    expect(new Set(tones.map((tone) => background(badge('X', tone)))).size).toBe(tones.length);
  });

  it('sets a foreground bold cannot brighten', () => {
    setColorEnabled(true);
    for (const tone of ['bad', 'caution', 'good', 'info'] as const) {
      const rendered = badge('X', tone);
      // Bold stays — it is the emphasis a decision line is entitled to.
      expect(rendered).toContain('\u001b[1m');
      // But never over a basic 30–37 foreground: bold plus one of those is the
      // legacy "use the bright variant" signal, and terminals honouring it
      // (iTerm2 among them) would render the black label grey on the block.
      expect(rendered).not.toMatch(/\u001b\[3[0-7]m/);
      expect(rendered).toContain('\u001b[38;5;16m');
    }
  });

  it('degrades to the bare label under NO_COLOR', () => {
    setColorEnabled(false);
    expect(badge('APPROVED', 'good')).toBe('APPROVED');
  });
});

describe('worker colours', () => {
  it('gives one issue the same colour every time', () => {
    setColorEnabled(true);
    expect(worker('PRD-006/issue-07', 'a')).toBe(worker('PRD-006/issue-07', 'a'));
  });

  it('never assigns red or yellow — they mean failure and caution elsewhere', () => {
    setColorEnabled(true);
    const ids = Array.from({ length: 200 }, (_, index) => `PRD-00${index}/issue-${index}`);
    const codes = new Set(ids.map((id) => worker(id, 'x').slice(0, 5)));
    expect(codes.has(`${ESC}[31m`)).toBe(false);
    expect(codes.has(`${ESC}[33m`)).toBe(false);
    // The palette is actually being spread, not collapsing onto one colour.
    expect(codes.size).toBeGreaterThan(1);
  });
});
