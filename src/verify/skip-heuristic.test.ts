import { describe, expect, it } from 'vitest';

import { decideSkip, describeSkip, hashTree, type TreeEntry } from './skip-heuristic.js';

const entries: TreeEntry[] = [
  { path: 'src/a.ts', size: 10, mtimeMs: 1000 },
  { path: 'src/b.ts', size: 20, mtimeMs: 2000 },
];

describe('hashTree', () => {
  it('is stable regardless of listing order', () => {
    expect(hashTree(entries)).toBe(hashTree([...entries].reverse()));
  });

  it('changes when a file changes size or mtime', () => {
    const base = hashTree(entries);
    expect(hashTree([{ ...entries[0]!, size: 11 }, entries[1]!])).not.toBe(base);
    expect(hashTree([{ ...entries[0]!, mtimeMs: 1001 }, entries[1]!])).not.toBe(base);
  });

  it('ignores sub-millisecond mtime jitter', () => {
    expect(hashTree([{ ...entries[0]!, mtimeMs: 1000.7 }, entries[1]!])).toBe(hashTree(entries));
  });

  it('changes when a file appears', () => {
    expect(hashTree([...entries, { path: 'src/c.ts', size: 1, mtimeMs: 3 }])).not.toBe(hashTree(entries));
  });
});

describe('decideSkip', () => {
  it('never skips when the gate has never passed', () => {
    expect(decideSkip('abc', null)).toEqual({ skip: false, reason: 'no previously verified tree to compare against' });
  });

  it('runs the gate when the tree moved', () => {
    expect(decideSkip('abc', 'def').skip).toBe(false);
  });

  it('skips when the tree is untouched since the last green verify', () => {
    expect(decideSkip('abc', 'abc').skip).toBe(true);
  });
});

describe('describeSkip', () => {
  it('says which way it went and why', () => {
    expect(describeSkip(decideSkip('a', 'a'), 'npm test')).toBe('skipping `npm test` — tree identical to the last green verify');
    expect(describeSkip(decideSkip('a', 'b'), 'npm test')).toBe('running `npm test` — tree changed since the last green verify');
  });
});
