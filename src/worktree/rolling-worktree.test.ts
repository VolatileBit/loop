import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureRollingWorktree, resolveRollingBranchName, resolveWorktreeDir } from './rolling-worktree.js';

function git(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function commit(cwd: string, file: string, contents: string, message: string): void {
  writeFileSync(path.join(cwd, file), contents);
  git(['add', file], cwd);
  git(['commit', '-m', message], cwd);
}

function createRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-worktree-test-'));
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'loop@example.com'], dir);
  git(['config', 'user.name', 'Loop Test'], dir);
  commit(dir, 'README.md', 'hello\n', 'chore: init');
  return dir;
}

const createdRoots: string[] = [];

afterEach(() => {
  for (const dir of createdRoots.splice(0)) {
    const worktreeDir = resolveWorktreeDir(dir);
    rmSync(worktreeDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('ensureRollingWorktree', () => {
  it('creates a sibling worktree on loop/rolling/<branch> the first time', () => {
    const mainRoot = createRepo();
    createdRoots.push(mainRoot);

    const result = ensureRollingWorktree(mainRoot);

    expect(result.usingWorktree).toBe(true);
    expect(result.currentBranch).toBe('main');
    expect(result.rollingBranch).toBe(resolveRollingBranchName('main'));
    expect(result.workRoot).toBe(resolveWorktreeDir(mainRoot));
    expect(result.synced).toBe(true);
  });

  it('is a no-op (already up to date) on a second call with no new commits', () => {
    const mainRoot = createRepo();
    createdRoots.push(mainRoot);
    ensureRollingWorktree(mainRoot);

    const result = ensureRollingWorktree(mainRoot);
    expect(result.usingWorktree).toBe(true);
    expect(result.synced).toBe(true);
    expect(result.skippedSyncReason).toBeNull();
  });

  it('fast-forwards the worktree when the current branch has advanced and the worktree is clean', () => {
    const mainRoot = createRepo();
    createdRoots.push(mainRoot);
    const first = ensureRollingWorktree(mainRoot);
    const beforeSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: first.workRoot, encoding: 'utf8' }).stdout.trim();

    commit(mainRoot, 'a.txt', 'a\n', 'feat: add a');

    const result = ensureRollingWorktree(mainRoot);
    expect(result.synced).toBe(true);
    expect(result.skippedSyncReason).toBeNull();

    const afterSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: result.workRoot, encoding: 'utf8' }).stdout.trim();
    const mainSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: mainRoot, encoding: 'utf8' }).stdout.trim();
    expect(afterSha).not.toBe(beforeSha);
    expect(afterSha).toBe(mainSha);
  });

  it('skips sync when the worktree has uncommitted changes', () => {
    const mainRoot = createRepo();
    createdRoots.push(mainRoot);
    const first = ensureRollingWorktree(mainRoot);
    writeFileSync(path.join(first.workRoot, 'dirty.txt'), 'uncommitted\n');
    commit(mainRoot, 'a.txt', 'a\n', 'feat: add a');

    const result = ensureRollingWorktree(mainRoot);
    expect(result.synced).toBe(false);
    expect(result.skippedSyncReason).toBe('uncommitted-changes');
  });

  it('skips sync when the worktree has unmerged commits', () => {
    const mainRoot = createRepo();
    createdRoots.push(mainRoot);
    const first = ensureRollingWorktree(mainRoot);
    commit(first.workRoot, 'wip.txt', 'wip\n', 'feat: unmerged work');
    commit(mainRoot, 'a.txt', 'a\n', 'feat: add a');

    const result = ensureRollingWorktree(mainRoot);
    expect(result.synced).toBe(false);
    expect(result.skippedSyncReason).toBe('unmerged-commits');
  });

  it('runs the configured installCmd when configured dependency files change during sync', () => {
    const mainRoot = createRepo();
    createdRoots.push(mainRoot);
    ensureRollingWorktree(mainRoot);
    commit(mainRoot, 'package.json', '{"name":"x"}\n', 'chore: bump deps');

    const result = ensureRollingWorktree(mainRoot, {
      installCmd: `node -e "require('fs').writeFileSync('install-ran.txt','1')"`,
      dependencyFiles: ['package.json', 'pnpm-lock.yaml'],
    });

    expect(result.ranInstall).toBe(true);
    expect(existsSync(path.join(result.workRoot, 'install-ran.txt'))).toBe(true);
  });

  it('does not auto-install when no installCmd is configured', () => {
    const mainRoot = createRepo();
    createdRoots.push(mainRoot);
    ensureRollingWorktree(mainRoot);
    commit(mainRoot, 'package.json', '{"name":"x"}\n', 'chore: bump deps');

    const result = ensureRollingWorktree(mainRoot);

    expect(result.synced).toBe(true);
    expect(result.ranInstall).toBe(false);
  });

  it('does not install when only non-dependency files changed', () => {
    const mainRoot = createRepo();
    createdRoots.push(mainRoot);
    ensureRollingWorktree(mainRoot);
    commit(mainRoot, 'src.txt', 'code\n', 'feat: change code');

    const result = ensureRollingWorktree(mainRoot, {
      installCmd: `node -e "require('fs').writeFileSync('install-ran.txt','1')"`,
      dependencyFiles: ['package.json'],
    });

    expect(result.synced).toBe(true);
    expect(result.ranInstall).toBe(false);
    expect(existsSync(path.join(result.workRoot, 'install-ran.txt'))).toBe(false);
  });

  it('falls back to the main repo when disabled', () => {
    const mainRoot = createRepo();
    createdRoots.push(mainRoot);
    const result = ensureRollingWorktree(mainRoot, { disabled: true });
    expect(result.usingWorktree).toBe(false);
    expect(result.workRoot).toBe(mainRoot);
  });

  it('falls back to the main repo when not a git repository', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'loop-worktree-nongit-'));
    const result = ensureRollingWorktree(dir);
    expect(result.usingWorktree).toBe(false);
    expect(result.workRoot).toBe(dir);
    rmSync(dir, { recursive: true, force: true });
  });
});
