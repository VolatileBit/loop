import { afterEach, describe, expect, it } from 'vitest';

import { setColorEnabled } from './style.js';
import {
  compactStageName,
  contentWidth,
  formatOutputPrefix,
  MAX_LINE_WIDTH,
  parseStageLabel,
  prefixWidth,
  wrapToWidth,
} from './output-prefix.js';

afterEach(() => {
  setColorEnabled(null);
});

describe('compactStageName', () => {
  it('shortens only the review round, where "round" adds nothing', () => {
    expect(compactStageName('review-round-6')).toBe('review-6');
  });

  it('keeps the fix stages explicit — the short forms name different things', () => {
    // `verify-1` reads as the first verify, not the first fix after one failed;
    // `fix-1` loses which loop it belongs to.
    expect(compactStageName('verify-fix-3')).toBe('verify-fix-3');
    expect(compactStageName('review-fix-2')).toBe('review-fix-2');
  });

  it('leaves the unnumbered stages alone', () => {
    expect(compactStageName('implement')).toBe('implement');
    expect(compactStageName('verify')).toBe('verify');
  });
});

describe('parseStageLabel', () => {
  it('splits a pipeline label into its parts', () => {
    expect(parseStageLabel('PRD-011/issue-01-review-round-6')).toEqual({
      project: 'PRD-011',
      issueId: 'issue-01',
      stage: 'review-6',
    });
  });

  it('handles a label with no stage suffix', () => {
    expect(parseStageLabel('PRD-011/issue-01')).toEqual({
      project: 'PRD-011',
      issueId: 'issue-01',
      stage: null,
    });
  });

  it('treats an empty label as loop speaking about nothing in particular', () => {
    expect(parseStageLabel('')).toEqual({ project: null, issueId: null, stage: null });
  });
});

describe('formatOutputPrefix', () => {
  it('names the issue and stage, and drops the project', () => {
    // The project is constant for a whole run in the common case, and the run
    // header already gives it in full.
    expect(formatOutputPrefix('loop', 'PRD-011/issue-01-review-round-6')).toBe('[01|review-6]');
    expect(formatOutputPrefix('agent', 'PRD-011/issue-01-review-fix-1')).toBe('[01|review-fix-1]');
  });

  it('is just [loop] for lines about no particular issue, whoever asked', () => {
    // A bare `[agent]` would claim an issue-less line came from a session.
    expect(formatOutputPrefix('loop')).toBe('[loop]');
    expect(formatOutputPrefix('loop', '', 'stderr')).toBe('[loop|stderr]');
    expect(formatOutputPrefix('agent')).toBe('[loop]');
    expect(formatOutputPrefix('think')).toBe('[loop]');
  });

  it('gives loop and the agent the same label — the gutter separates them', () => {
    // Spending prefix columns on the voice would duplicate what the `│` already
    // says, and the gutter survives NO_COLOR and the plain-text log.
    const label = 'PRD-011/issue-01-implement';
    expect(formatOutputPrefix('agent', label)).toBe(formatOutputPrefix('loop', label));
  });

  it('leaves an id that is not <word>-<number> shaped alone', () => {
    expect(formatOutputPrefix('loop', 'PRD-011/hotfix-login-implement')).toBe(
      '[hotfix-login|implement]',
    );
  });

  it('gives every line about one issue the same colour, and different issues different ones', () => {
    setColorEnabled(true);
    const one = formatOutputPrefix('loop', 'PRD-011/issue-01-implement');
    const oneAgain = formatOutputPrefix('agent', 'PRD-011/issue-01-review-round-2');
    const two = formatOutputPrefix('loop', 'PRD-011/issue-02-implement');

    // The leading SGR sequence is the colour; compare that, not the label.
    const colourOf = (prefix: string): string => prefix.match(/^\u001b\[[0-9;]*m/)?.[0] ?? '';
    expect(colourOf(one)).not.toBe('');
    expect(colourOf(one)).toBe(colourOf(oneAgain));
    expect(colourOf(one)).not.toBe(colourOf(two));
  });

  it('keys colour on the qualified id, so two projects’ issue-01 differ', () => {
    setColorEnabled(true);
    const a = formatOutputPrefix('loop', 'PRD-A/issue-01-implement');
    const b = formatOutputPrefix('loop', 'PRD-B/issue-01-implement');
    // Same visible label — the colour is the whole of what keeps them apart.
    expect(a).not.toBe(b);
    expect(a.replace(/\u001b\[[0-9;]*m/g, '')).toBe(b.replace(/\u001b\[[0-9;]*m/g, ''));
  });
});

describe('prefixWidth', () => {
  it('measures what the eye sees, not the styling codes', () => {
    setColorEnabled(true);
    const styled = formatOutputPrefix('loop', 'PRD-011/issue-01-implement');
    expect(styled.length).toBeGreaterThan(prefixWidth(styled));
    expect(prefixWidth(styled)).toBe('[01|implement]'.length);
  });
});

describe('contentWidth', () => {
  it('leaves room for the stamp the invocation log adds downstream', () => {
    // `HH:MM:SS ` is prepended after every wrap and cut decision is made, so a
    // budget that ignored it would overshoot the line by nine columns.
    expect(contentWidth('') + 'HH:MM:SS '.length).toBe(MAX_LINE_WIDTH);
  });

  it('charges for the prefix as it looks, not as it is stored', () => {
    setColorEnabled(true);
    const styled = formatOutputPrefix('loop', 'PRD-011/issue-01-implement');
    expect(contentWidth(styled)).toBe(contentWidth('[01|implement]'));
  });

  it('subtracts whatever sits between the prefix and the text', () => {
    expect(contentWidth('[01]', 3)).toBe(contentWidth('[01]') - 3);
  });
});

describe('wrapToWidth', () => {
  it('breaks at word boundaries and never exceeds the width', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    for (const line of wrapToWidth(text, 12)) expect(line.length).toBeLessThanOrEqual(12);
    expect(wrapToWidth(text, 12).join(' ')).toBe(text);
  });

  it('hard-splits a word wider than the line rather than overflowing', () => {
    // A URL, a stack frame or a base64 blob has no break to prefer.
    const blob = 'x'.repeat(25);
    const lines = wrapToWidth(`see ${blob} end`, 10);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(10);
    expect(lines.join('').replace(/ /g, '')).toBe(`see${blob}end`);
  });

  it('leaves a line that already fits untouched', () => {
    expect(wrapToWidth('short', 80)).toEqual(['short']);
  });

  it('preserves an empty line rather than dropping it', () => {
    expect(wrapToWidth('', 80)).toEqual(['']);
  });
});
