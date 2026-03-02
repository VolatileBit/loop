import { describe, expect, it } from 'vitest';

import { createEvidenceTracker, isProven } from './evidence.js';

const WORKTREE = '/work/repo-loop';

describe('evidence tracker — proven commands', () => {
  it('proves a command that succeeded with a clean tail', () => {
    const tracker = createEvidenceTracker({ worktreeRoot: WORKTREE });
    tracker.observeToolUse('Bash', { command: 'pnpm test' });
    tracker.observeExec('pnpm test', true);
    expect(tracker.provenCommands()).toEqual(['pnpm test']);
  });

  it('survives git bookkeeping, including chained add && commit', () => {
    const tracker = createEvidenceTracker({ worktreeRoot: WORKTREE });
    tracker.observeExec('pnpm test', true);
    tracker.observeToolUse('Bash', { command: 'git status' });
    tracker.observeToolUse('Bash', { command: 'git add -A && git commit -m "feat: done (PRD-1/issue-1)"' });
    tracker.observeToolUse('Bash', { command: 'git worktree list' });
    expect(tracker.provenCommands()).toEqual(['pnpm test']);
  });

  it('is retracted by an in-tree edit after the run', () => {
    const tracker = createEvidenceTracker({ worktreeRoot: WORKTREE });
    tracker.observeExec('pnpm test', true);
    tracker.observeToolUse('Edit', { file_path: `${WORKTREE}/src/a.ts` });
    expect(tracker.provenCommands()).toEqual([]);
  });

  it('is retracted by a non-git shell command after the run', () => {
    const tracker = createEvidenceTracker({ worktreeRoot: WORKTREE });
    tracker.observeExec('pnpm test', true);
    tracker.observeToolUse('Bash', { command: 'rm -rf dist' });
    expect(tracker.provenCommands()).toEqual([]);
  });

  it('is retracted by a later failed run of the same command', () => {
    const tracker = createEvidenceTracker({ worktreeRoot: WORKTREE });
    tracker.observeExec('pnpm test', true);
    tracker.observeExec('pnpm test', false);
    expect(tracker.provenCommands()).toEqual([]);
  });

  it('is re-proven by a re-run after invalidation', () => {
    const tracker = createEvidenceTracker({ worktreeRoot: WORKTREE });
    tracker.observeExec('pnpm test', true);
    tracker.observeToolUse('Edit', { file_path: `${WORKTREE}/src/a.ts` });
    tracker.observeToolUse('Bash', { command: 'pnpm test' });
    tracker.observeExec('pnpm test', true);
    expect(tracker.provenCommands()).toEqual(['pnpm test']);
  });

  it('survives read-only tools across CLI vocabularies, and Skill', () => {
    const tracker = createEvidenceTracker({ worktreeRoot: WORKTREE });
    tracker.observeExec('pnpm test', true);
    tracker.observeToolUse('Read', { file_path: `${WORKTREE}/src/a.ts` });
    tracker.observeToolUse('Grep', { pattern: 'foo' });
    tracker.observeToolUse('TodoWrite', { todos: [] });
    tracker.observeToolUse('Skill', { skill: 'commit' });
    tracker.observeToolUse('read', { path: `${WORKTREE}/src/a.ts` }); // cursor
    tracker.observeToolUse('web_search', { query: 'docs' }); // codex
    expect(tracker.provenCommands()).toEqual(['pnpm test']);
  });

  it('is retracted by unknown tools (MCP, Task, anything unrecognized)', () => {
    const tracker = createEvidenceTracker({ worktreeRoot: WORKTREE });
    tracker.observeExec('pnpm test', true);
    tracker.observeToolUse('mcp__github__create_issue', { title: 'x' });
    expect(tracker.provenCommands()).toEqual([]);
  });

  it('is retracted by git chains hiding metacharacters', () => {
    const tracker = createEvidenceTracker({ worktreeRoot: WORKTREE });
    tracker.observeExec('pnpm test', true);
    tracker.observeToolUse('Bash', { command: 'git status; rm -rf /' });
    expect(tracker.provenCommands()).toEqual([]);

    const backtick = createEvidenceTracker({ worktreeRoot: WORKTREE });
    backtick.observeExec('pnpm test', true);
    backtick.observeToolUse('Bash', { command: 'git add `find . -name x`' });
    expect(backtick.provenCommands()).toEqual([]);

    const chained = createEvidenceTracker({ worktreeRoot: WORKTREE });
    chained.observeExec('pnpm test', true);
    chained.observeToolUse('Bash', { command: 'git status && pnpm build' });
    expect(chained.provenCommands()).toEqual([]);
  });

  it('returns [] when nothing was observed', () => {
    expect(createEvidenceTracker({ worktreeRoot: WORKTREE }).provenCommands()).toEqual([]);
  });
});

describe('evidence tracker — write-path rules', () => {
  it('out-of-tree absolute writes survive (loop bookkeeping lives outside the worktree)', () => {
    const tracker = createEvidenceTracker({ worktreeRoot: WORKTREE });
    tracker.observeExec('pnpm test', true);
    tracker.observeToolUse('Write', { file_path: '/work/repo/.loop/nits.md' });
    tracker.observeToolUse('edit', { path: '/work/repo/.loop/nits.md' }); // cursor/copilot vocabulary
    expect(tracker.provenCommands()).toEqual(['pnpm test']);
  });

  it('in-tree writes retract', () => {
    const tracker = createEvidenceTracker({ worktreeRoot: WORKTREE });
    tracker.observeExec('pnpm test', true);
    tracker.observeToolUse('Write', { file_path: `${WORKTREE}/notes.md` });
    expect(tracker.provenCommands()).toEqual([]);
  });

  it('relative paths retract (cwd is the worktree)', () => {
    const tracker = createEvidenceTracker({ worktreeRoot: WORKTREE });
    tracker.observeExec('pnpm test', true);
    tracker.observeToolUse('Write', { file_path: 'notes.md' });
    expect(tracker.provenCommands()).toEqual([]);
  });

  it('writes retract when no worktree root is configured', () => {
    const tracker = createEvidenceTracker({});
    tracker.observeExec('pnpm test', true);
    tracker.observeToolUse('Write', { file_path: '/anywhere/else.md' });
    expect(tracker.provenCommands()).toEqual([]);
  });

  it('codex file_change paths: all outside survives, any inside retracts', () => {
    const outside = createEvidenceTracker({ worktreeRoot: WORKTREE });
    outside.observeExec('pnpm test', true);
    outside.observeToolUse('file_change', { paths: ['/work/repo/.loop/a.md', '/work/repo/.loop/b.md'] });
    expect(outside.provenCommands()).toEqual(['pnpm test']);

    const mixed = createEvidenceTracker({ worktreeRoot: WORKTREE });
    mixed.observeExec('pnpm test', true);
    mixed.observeToolUse('file_change', { paths: ['/work/repo/.loop/a.md', `${WORKTREE}/src/a.ts`] });
    expect(mixed.provenCommands()).toEqual([]);
  });
});

describe('isProven', () => {
  it('matches exact commands, whitespace-insensitively at the ends', () => {
    expect(isProven(['pnpm test'], 'pnpm test')).toBe(true);
    expect(isProven(['  pnpm test  '], ' pnpm test ')).toBe(true);
  });

  it('matches when every && segment is individually proven', () => {
    expect(isProven(['pnpm typecheck', 'pnpm test'], 'pnpm typecheck && pnpm test')).toBe(true);
  });

  it('rejects partially-proven segment sets', () => {
    expect(isProven(['pnpm typecheck'], 'pnpm typecheck && pnpm test')).toBe(false);
  });

  it('rejects unrelated commands', () => {
    expect(isProven(['pnpm build'], 'pnpm test')).toBe(false);
    expect(isProven([], 'pnpm test')).toBe(false);
  });

  it('does not fall back to segment matching for single-segment commands', () => {
    expect(isProven(['pnpm'], 'pnpm test')).toBe(false);
  });
});
