import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDirs, makeIssue, makeTempRoot } from '../issues/test-helpers.js';
import { appendNits, hasNitsEntries, parseNits, parseNitsDecisions } from './nits.js';
import { parseReviewVerdict } from './verdict.js';

afterEach(() => {
  cleanupTempDirs();
});

describe('parseNits', () => {
  it('extracts bullet items from the Loop nits block', () => {
    const nits = parseNits(`
## Spec
Looks fine.

## Loop nits
- Rename \`foo\` to \`bar\` for clarity.
- Add a comment explaining the seam.

## Loop verdict
changes-requested: yes
severity: nits-only
summary: Minor naming suggestions only.
`);
    expect(nits).toEqual([
      'Rename `foo` to `bar` for clarity.',
      'Add a comment explaining the seam.',
    ]);
  });

  it('returns an empty array when there is no nits block', () => {
    expect(parseNits('## Loop verdict\nchanges-requested: no\nseverity: none\nsummary: ok\n')).toEqual([]);
  });
});

describe('appendNits', () => {
  it('appends a dated section per issue to .loop/nits.md, falling back to the summary', () => {
    const root = makeTempRoot('loop-nits-');
    const issue = makeIssue({ id: 'issue-07', project: 'PRD-006', title: 'Timeouts' });
    const verdict = parseReviewVerdict(`
## Loop nits
- Prefer a narrower type.

## Loop verdict
changes-requested: yes
severity: nits-only
summary: One naming nit.
`);
    appendNits(root, issue, verdict, path.join(root, '.loop', 'runs', 'PRD-006', 'x-review'));

    const noNitsVerdict = parseReviewVerdict(`
## Loop verdict
changes-requested: yes
severity: nits-only
summary: Nit without a block.
`);
    appendNits(root, issue, noNitsVerdict, path.join(root, '.loop', 'runs', 'PRD-006', 'y-review'));

    const contents = readFileSync(path.join(root, '.loop', 'nits.md'), 'utf8');
    expect(contents).toContain('## PRD-006/issue-07 — Timeouts');
    expect(contents).toContain('- Prefer a narrower type.');
    expect(contents).toContain('- Nit without a block.');
    expect(contents).toContain('.loop/runs/PRD-006/x-review/review.md');
    expect(hasNitsEntries(contents)).toBe(true);
  });
});

describe('hasNitsEntries', () => {
  it('is false for empty or section-free content', () => {
    expect(hasNitsEntries('')).toBe(false);
    expect(hasNitsEntries('just prose\n')).toBe(false);
  });
});

describe('parseNitsDecisions', () => {
  it('parses fixed/dismissed bullets with notes', () => {
    expect(
      parseNitsDecisions(`
All done.

## Loop nits decisions
- PRD-006/issue-07: fixed — renamed the helper
- PRD-006/issue-09: dismissed — intentional per ADR-3
`),
    ).toEqual([
      { qualifiedId: 'PRD-006/issue-07', action: 'fixed', note: 'renamed the helper' },
      { qualifiedId: 'PRD-006/issue-09', action: 'dismissed', note: 'intentional per ADR-3' },
    ]);
  });

  it('throws on a missing block, an empty block, or an unparseable bullet', () => {
    expect(() => parseNitsDecisions('no block here')).toThrow(/no "## Loop nits decisions" block/);
    expect(() => parseNitsDecisions('## Loop nits decisions\n(nothing)')).toThrow(/no decision bullets/);
    expect(() => parseNitsDecisions('## Loop nits decisions\n- PRD-1/issue-1: shrugged — eh')).toThrow(
      /unparseable nits decision line/,
    );
  });
});
