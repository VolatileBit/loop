import { describe, expect, it } from 'vitest';

import { changedPaths, isDirty, isolationBranchName, parseStashRef, planRestore, planSwap } from './branch-swap.js';

describe('isolationBranchName', () => {
  it('slugs an issue id into a namespaced branch', () => {
    expect(isolationBranchName('PRD-006/issue-07')).toBe('loop/iso/prd-006-issue-07');
  });

  it('collapses characters git would reject and trims the edges', () => {
    expect(isolationBranchName('  ..weird//id.. ')).toBe('loop/iso/weird-id');
  });

  it('falls back to a constant when nothing survives slugging', () => {
    expect(isolationBranchName('///')).toBe('loop/iso/issue');
  });

  it('suffixes retries so a stale branch does not collide', () => {
    expect(isolationBranchName('issue-01', 2)).toBe('loop/iso/issue-01-2');
  });
});

describe('changedPaths / isDirty', () => {
  it('reads paths out of porcelain output', () => {
    const out = ' M src/a.ts\n?? src/b.ts\n';
    expect(changedPaths(out)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(isDirty(out)).toBe(true);
  });

  it('takes the destination of a rename', () => {
    expect(changedPaths('R  old.ts -> new.ts')).toEqual(['new.ts']);
  });

  it('treats empty output as clean', () => {
    expect(isDirty('')).toBe(false);
  });
});

describe('parseStashRef', () => {
  it('finds the ref in either git phrasing', () => {
    expect(parseStashRef('Saved working directory and index state WIP on main: abc1234 msg\nstash@{0}')).toBe('stash@{0}');
    expect(parseStashRef('stash@{3}: WIP on main')).toBe('stash@{3}');
  });

  it('returns null when nothing was stashed', () => {
    expect(parseStashRef('No local changes to save')).toBeNull();
  });
});

describe('planSwap / planRestore', () => {
  it('stashes before switching when the tree is dirty', () => {
    expect(planSwap('main', 'loop/iso/x', true)).toEqual([
      'git stash push --include-untracked -m "loop: parked main"',
      'git checkout -B loop/iso/x',
    ]);
  });

  it('skips the stash when the tree is clean', () => {
    expect(planSwap('main', 'loop/iso/x', false)).toEqual(['git checkout -B loop/iso/x']);
  });

  it('restores the branch and pops only a stash it made', () => {
    expect(planRestore({ branch: 'main', dirty: true, stashRef: 'stash@{0}' })).toEqual([
      'git checkout main',
      'git stash pop stash@{0}',
    ]);
    expect(planRestore({ branch: 'main', dirty: false, stashRef: null })).toEqual(['git checkout main']);
  });
});
