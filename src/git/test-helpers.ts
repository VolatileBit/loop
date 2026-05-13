/** Shared vitest fixtures for git-backed tests (not a test file itself). */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Run git, throwing on failure — fixture setup should never fail silently. */
export function gitOrThrow(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
}

export function commitFile(cwd: string, file: string, contents: string, message: string): void {
  const filePath = path.join(cwd, file);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  gitOrThrow(['add', file], cwd);
  gitOrThrow(['commit', '-m', message], cwd);
}

const fixtureDirs: string[] = [];

/** mkdtemp + git init a throwaway repo with one initial commit; tracked for cleanupFixtureRepos(). */
export function createFixtureRepo(prefix = 'loop-git-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  fixtureDirs.push(dir);
  gitOrThrow(['init', '-b', 'main'], dir);
  gitOrThrow(['config', 'user.email', 'loop@example.com'], dir);
  gitOrThrow(['config', 'user.name', 'Loop Test'], dir);
  commitFile(dir, 'README.md', 'hello\n', 'chore: init');
  return dir;
}

/** Track an extra dir (e.g. a worktree sibling) for cleanupFixtureRepos(). */
export function trackFixtureDir(dir: string): void {
  fixtureDirs.push(dir);
}

export function cleanupFixtureRepos(): void {
  while (fixtureDirs.length > 0) rmSync(fixtureDirs.pop()!, { recursive: true, force: true });
}
