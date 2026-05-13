import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildLoopCommitMessage,
  commitStagedChanges,
  defaultCommitTypeForLabel,
  ensureLoopCommit,
  isLoopCommitType,
  parseCommitSuggestion,
  resolveImplementCommitLabel,
  stageLoopChanges,
} from './commit.js';
import { listDirtyPaths } from './status.js';
import { cleanupFixtureRepos, createFixtureRepo, gitOrThrow, trackFixtureDir } from './test-helpers.js';

afterEach(() => {
  cleanupFixtureRepos();
});

describe('defaultCommitTypeForLabel', () => {
  it('maps loop-internal stage labels to conventional commit types', () => {
    expect(defaultCommitTypeForLabel('implement')).toBe('feat');
    expect(defaultCommitTypeForLabel('verify-fix-1')).toBe('fix');
    expect(defaultCommitTypeForLabel('review-fix-2')).toBe('fix');
    expect(defaultCommitTypeForLabel('escalate')).toBe('review');
    expect(defaultCommitTypeForLabel('complete')).toBe('chore');
  });
});

describe('isLoopCommitType', () => {
  it('accepts only the five conventional types', () => {
    expect(isLoopCommitType('feat')).toBe(true);
    expect(isLoopCommitType('doc')).toBe(true);
    expect(isLoopCommitType('docs')).toBe(false);
    expect(isLoopCommitType('bogus')).toBe(false);
  });
});

describe('buildLoopCommitMessage', () => {
  it('defaults to a type inferred from the label, suffixed with the qualifiedId', () => {
    expect(buildLoopCommitMessage('PRD-006/issue-07', 'implement')).toBe('feat: implement (PRD-006/issue-07)');
    expect(buildLoopCommitMessage('PRD-002/issue-10', 'verify-fix-2')).toBe('fix: verify fix 2 (PRD-002/issue-10)');
  });

  it('prefers an agent-suggested type and summary', () => {
    expect(
      buildLoopCommitMessage('PRD-001/issue-01', 'implement', { type: 'doc', summary: 'document the new flag' }),
    ).toBe('doc: document the new flag (PRD-001/issue-01)');
  });
});

describe('resolveImplementCommitLabel', () => {
  it('defaults to implement', () => {
    expect(resolveImplementCommitLabel({})).toBe('implement');
  });

  it('uses verify and review fix round labels', () => {
    expect(resolveImplementCommitLabel({ verifyFeedback: { round: 2 } })).toBe('verify-fix-2');
    expect(resolveImplementCommitLabel({ reviewFeedback: { round: 1 } })).toBe('review-fix-1');
    expect(resolveImplementCommitLabel({ commitLabel: 'complete' })).toBe('complete');
  });
});

describe('parseCommitSuggestion', () => {
  it('parses type and summary from the ## Loop commit block', () => {
    const text = ['All done.', '', '## Loop commit', '', 'type: fix', 'summary: handle the empty case', ''].join('\n');
    expect(parseCommitSuggestion(text)).toEqual({ type: 'fix', summary: 'handle the empty case' });
  });

  it('returns null when the block is missing or the type is unknown', () => {
    expect(parseCommitSuggestion('no commit block here')).toBeNull();
    expect(parseCommitSuggestion('## Loop commit\ntype: docs\nsummary: nope')).toBeNull();
    expect(parseCommitSuggestion('## Loop commit\ntype: fix')).toBeNull();
  });

  it('stops at the next heading', () => {
    const text = ['## Loop commit', 'type: feat', 'summary: add thing', '## Loop handoff', 'type: fix'].join('\n');
    expect(parseCommitSuggestion(text)).toEqual({ type: 'feat', summary: 'add thing' });
  });
});

function stagedFiles(cwd: string): string[] {
  return gitOrThrow(['diff', '--cached', '--name-only'], cwd).split('\n').filter(Boolean).sort();
}

describe('stageLoopChanges', () => {
  it('stages everything when no excludes are configured', () => {
    const repo = createFixtureRepo();
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    mkdirSync(path.join(repo, 'sub'));
    writeFileSync(path.join(repo, 'sub', 'b.txt'), 'b\n');

    const result = stageLoopChanges(repo);
    expect(result.ok).toBe(true);
    expect(stagedFiles(repo)).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('succeeds when .loop is properly gitignored (explicit pathspecs would exit 1 here)', () => {
    const repo = createFixtureRepo();
    writeFileSync(path.join(repo, '.gitignore'), '.loop/\n');
    gitOrThrow(['add', '.gitignore'], repo);
    gitOrThrow(['commit', '-m', 'ignore .loop'], repo);
    mkdirSync(path.join(repo, '.loop', 'runs'), { recursive: true });
    writeFileSync(path.join(repo, '.loop', 'runs', 'agent.stream.log'), 'stream\n');
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');

    const result = stageLoopChanges(repo, ['tmp']);
    expect(result.ok).toBe(true);
    expect(stagedFiles(repo)).toEqual(['a.txt']);
  });

  it('never stages .loop runtime state, even without a gitignore', () => {
    const repo = createFixtureRepo();
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    mkdirSync(path.join(repo, '.loop', 'runs'), { recursive: true });
    writeFileSync(path.join(repo, '.loop', 'runs', 'agent.stream.log'), 'stream\n');

    const result = stageLoopChanges(repo);
    expect(result.ok).toBe(true);
    expect(stagedFiles(repo)).toEqual(['a.txt']);
  });

  it('excludes the configured pathspecs', () => {
    const repo = createFixtureRepo();
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    mkdirSync(path.join(repo, '.polyweave-workspaces'));
    writeFileSync(path.join(repo, '.polyweave-workspaces', 'runtime.txt'), 'runtime\n');
    mkdirSync(path.join(repo, 'tmp'));
    writeFileSync(path.join(repo, 'tmp', 'scratch.txt'), 'scratch\n');

    const result = stageLoopChanges(repo, ['.polyweave-workspaces', 'tmp']);
    expect(result.ok).toBe(true);
    expect(stagedFiles(repo)).toEqual(['a.txt']);
  });

  it('also stages tracked-file modifications and deletions', () => {
    const repo = createFixtureRepo();
    writeFileSync(path.join(repo, 'README.md'), 'changed\n');

    const result = stageLoopChanges(repo, ['ignored-dir']);
    expect(result.ok).toBe(true);
    expect(stagedFiles(repo)).toEqual(['README.md']);
  });
});

describe('commitStagedChanges', () => {
  it('commits staged changes and returns the new sha', () => {
    const repo = createFixtureRepo();
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    gitOrThrow(['add', 'a.txt'], repo);

    const result = commitStagedChanges('feat: add a (PRD-001/issue-01)', repo);
    expect(result.ok).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(gitOrThrow(['log', '-1', '--format=%s'], repo)).toBe('feat: add a (PRD-001/issue-01)');
  });
});

describe('ensureLoopCommit', () => {
  it('no-ops when the working tree is clean', () => {
    const repo = createFixtureRepo();
    const result = ensureLoopCommit('PRD-001/issue-01', 'implement', { cwd: repo });
    expect(result.committed).toBe(false);
    expect(result.output).toBe('working tree clean');
  });

  it('commits dirty changes minus excludes with the standard message', () => {
    const repo = createFixtureRepo();
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    mkdirSync(path.join(repo, 'runtime'));
    writeFileSync(path.join(repo, 'runtime', 'state.txt'), 'state\n');

    const result = ensureLoopCommit('PRD-006/issue-07', 'implement', {
      cwd: repo,
      excludePaths: ['runtime'],
    });

    expect(result.committed).toBe(true);
    expect(result.message).toBe('feat: implement (PRD-006/issue-07)');
    expect(gitOrThrow(['log', '-1', '--format=%s'], repo)).toBe('feat: implement (PRD-006/issue-07)');
    const committedFiles = gitOrThrow(['show', '--name-only', '--format=', 'HEAD'], repo)
      .split('\n')
      .filter(Boolean);
    expect(committedFiles).toEqual(['a.txt']);
    // Excluded file remains uncommitted in the working tree.
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout;
    expect(status).toContain('runtime/');
  });

  it('preserves paths that were dirty before the agent stage', () => {
    const repo = createFixtureRepo();
    writeFileSync(path.join(repo, 'README.md'), 'pre-existing user edit\n');
    writeFileSync(path.join(repo, 'agent-change.txt'), 'agent change\n');

    const result = ensureLoopCommit('PRD-011/issue-01', 'implement', {
      cwd: repo,
      preservePaths: ['README.md'],
    });

    expect(result.committed).toBe(true);
    const committedFiles = gitOrThrow(['show', '--name-only', '--format=', 'HEAD'], repo)
      .split('\n')
      .filter(Boolean);
    expect(committedFiles).toEqual(['agent-change.txt']);
    expect(gitOrThrow(['status', '--porcelain'], repo)).toContain('README.md');
  });

  it('restores the exact staged and unstaged state of a preserved path', () => {
    const repo = createFixtureRepo();
    writeFileSync(path.join(repo, 'README.md'), 'staged user edit\n');
    gitOrThrow(['add', 'README.md'], repo);
    writeFileSync(path.join(repo, 'README.md'), 'staged user edit\nunstaged user edit\n');
    const stagedBefore = gitOrThrow(['diff', '--cached', '--binary'], repo);
    writeFileSync(path.join(repo, 'agent-change.txt'), 'agent change\n');

    const result = ensureLoopCommit('PRD-011/issue-01', 'implement', {
      cwd: repo,
      preservePaths: ['README.md'],
    });

    expect(result.committed).toBe(true);
    expect(gitOrThrow(['diff', '--cached', '--binary'], repo)).toBe(stagedBefore);
    expect(gitOrThrow(['status', '--porcelain'], repo)).toContain('MM README.md');
  });

  it('no-ops successfully when only preserved paths are dirty', () => {
    const repo = createFixtureRepo();
    const headBefore = gitOrThrow(['rev-parse', 'HEAD'], repo);
    writeFileSync(path.join(repo, 'README.md'), 'pre-existing user edit\n');

    const result = ensureLoopCommit('PRD-011/issue-01', 'implement', {
      cwd: repo,
      preservePaths: ['README.md'],
    });

    expect(result.committed).toBe(false);
    expect(result.output).toBe('no loop changes to commit');
    expect(gitOrThrow(['rev-parse', 'HEAD'], repo)).toBe(headBefore);
    expect(gitOrThrow(['status', '--porcelain'], repo)).toContain('README.md');
  });

  it('preserves both sides of a staged rename discovered before the run', () => {
    const repo = createFixtureRepo();
    gitOrThrow(['mv', 'README.md', 'renamed.md'], repo);
    const stagedBefore = gitOrThrow(['diff', '--cached', '--binary'], repo);
    const preservePaths = listDirtyPaths(repo);
    writeFileSync(path.join(repo, 'agent-change.txt'), 'agent change\n');

    const result = ensureLoopCommit('PRD-011/issue-01', 'implement', {
      cwd: repo,
      preservePaths,
    });

    expect(preservePaths).toEqual(['README.md', 'renamed.md']);
    expect(result.committed).toBe(true);
    expect(gitOrThrow(['show', '--name-only', '--format=', 'HEAD'], repo)).toBe('agent-change.txt');
    expect(gitOrThrow(['diff', '--cached', '--binary'], repo)).toBe(stagedBefore);
  });

  it('reports not-a-git-repository without throwing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'loop-commit-nongit-'));
    trackFixtureDir(dir);
    const result = ensureLoopCommit('PRD-001/issue-01', 'implement', { cwd: dir });
    expect(result.committed).toBe(false);
    expect(result.output).toBe('not a git repository');
    expect(result.message).toBe('feat: implement (PRD-001/issue-01)');
  });
});
