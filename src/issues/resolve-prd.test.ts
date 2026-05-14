import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFixtureRepo, gitOrThrow } from '../git/test-helpers.js';
import { resolveIssuePrd } from './resolve-prd.js';
import { cleanupTempDirs, makeIssue, makeTempRoot } from './test-helpers.js';

import { cleanupFixtureRepos } from '../git/test-helpers.js';

afterEach(() => {
  cleanupTempDirs();
  cleanupFixtureRepos();
});

function makePrdsRoot(files: string[]): string {
  const root = makeTempRoot('loop-prd-');
  mkdirSync(path.join(root, 'docs/prd'), { recursive: true });
  for (const name of files) writeFileSync(path.join(root, 'docs/prd', name), `# ${name}\n`);
  return root;
}

describe('resolveIssuePrd', () => {
  it('is disabled (null) when prdsDir is unset', () => {
    const root = makePrdsRoot(['PRD-006-loop-refactor.md']);
    const issue = makeIssue({ id: 'issue-07', project: 'PRD-006' });
    expect(resolveIssuePrd(issue, { prdsDir: null, projects: {} }, root)).toBeNull();
  });

  it('matches issue.project against prdsDir by case-insensitive filename prefix', () => {
    const root = makePrdsRoot(['PRD-005-other.md', 'PRD-006-loop-refactor.md']);
    const issue = makeIssue({ id: 'issue-07', project: 'prd-006' });
    expect(resolveIssuePrd(issue, { prdsDir: 'docs/prd', projects: {} }, root)).toBe(
      path.join('docs', 'prd', 'PRD-006-loop-refactor.md'),
    );
  });

  it('requires a boundary after the prefix (PRD-006 must not match PRD-0061-*)', () => {
    const root = makePrdsRoot(['PRD-0061-lookalike.md']);
    const issue = makeIssue({ id: 'issue-01', project: 'PRD-006' });
    expect(resolveIssuePrd(issue, { prdsDir: 'docs/prd', projects: {} }, root)).toBeNull();
  });

  it('honors an explicit prd: frontmatter override as a filename prefix', () => {
    const root = makePrdsRoot(['PRD-006-loop-refactor.md', 'PRD-004-other.md']);
    const issue = makeIssue({ id: 'issue-01', project: 'hotfixes', prd: 'PRD-006' });
    expect(resolveIssuePrd(issue, { prdsDir: 'docs/prd', projects: {} }, root)).toBe(
      path.join('docs', 'prd', 'PRD-006-loop-refactor.md'),
    );
  });

  it('honors an explicit prd: frontmatter override as a repo-relative path', () => {
    const root = makePrdsRoot(['PRD-006-loop-refactor.md']);
    const issue = makeIssue({
      id: 'issue-01',
      project: 'hotfixes',
      prd: 'docs/prd/PRD-006-loop-refactor.md',
    });
    expect(resolveIssuePrd(issue, { prdsDir: 'docs/prd', projects: {} }, root)).toBe(
      path.join('docs', 'prd', 'PRD-006-loop-refactor.md'),
    );
  });

  it('honors a projects.<name>.prd config override (prefix or path), below frontmatter', () => {
    const root = makePrdsRoot(['PRD-006-loop-refactor.md', 'PRD-004-other.md']);
    const projects = { hotfixes: { prd: 'PRD-006' } };

    // Project config override applies when frontmatter has none.
    const fromConfig = makeIssue({ id: 'issue-01', project: 'hotfixes' });
    expect(resolveIssuePrd(fromConfig, { prdsDir: 'docs/prd', projects }, root)).toBe(
      path.join('docs', 'prd', 'PRD-006-loop-refactor.md'),
    );

    // Frontmatter prd: beats the project config.
    const fromFrontmatter = makeIssue({ id: 'issue-02', project: 'hotfixes', prd: 'PRD-004' });
    expect(resolveIssuePrd(fromFrontmatter, { prdsDir: 'docs/prd', projects }, root)).toBe(
      path.join('docs', 'prd', 'PRD-004-other.md'),
    );

    // A path-style project override works even without prdsDir.
    const pathOverride = { docs: { prd: 'docs/prd/PRD-004-other.md' } };
    const fromPath = makeIssue({ id: 'issue-03', project: 'docs' });
    expect(resolveIssuePrd(fromPath, { prdsDir: null, projects: pathOverride }, root)).toBe(
      path.join('docs', 'prd', 'PRD-004-other.md'),
    );
  });

  it('returns null (never throws) when nothing matches or prdsDir is missing', () => {
    const root = makePrdsRoot(['PRD-001-unrelated.md']);
    const noMatch = makeIssue({ id: 'issue-01', project: 'PRD-999' });
    expect(resolveIssuePrd(noMatch, { prdsDir: 'docs/prd', projects: {} }, root)).toBeNull();

    const badOverride = makeIssue({ id: 'issue-02', project: 'PRD-001', prd: 'PRD-404' });
    expect(resolveIssuePrd(badOverride, { prdsDir: 'docs/prd', projects: {} }, root)).toBeNull();

    const missingDir = makeIssue({ id: 'issue-03', project: 'PRD-001' });
    expect(resolveIssuePrd(missingDir, { prdsDir: 'no/such/dir', projects: {} }, root)).toBeNull();
  });
});

describe('resolveIssuePrd across worktrees', () => {
  /** A repo with one tracked PRD and one in a gitignored directory. */
  function repoWithPrds(): { root: string } {
    const root = createFixtureRepo('loop-prd-worktree-');
    mkdirSync(path.join(root, 'docs/prd'), { recursive: true });
    mkdirSync(path.join(root, '.planning'), { recursive: true });
    writeFileSync(path.join(root, 'docs/prd/PRD-006-tracked.md'), '# tracked\n');
    writeFileSync(path.join(root, '.planning/PRD-009-local.md'), '# untracked\n');
    writeFileSync(path.join(root, '.gitignore'), '.planning/\n');
    gitOrThrow(['add', '.'], root);
    gitOrThrow(['commit', '-m', 'chore: add prds'], root);
    return { root };
  }

  it('keeps a tracked PRD relative, since every worktree receives it', () => {
    const { root } = repoWithPrds();
    const issue = makeIssue({ id: 'issue-01', project: 'PRD-006' });
    expect(resolveIssuePrd(issue, { prdsDir: 'docs/prd', projects: {} }, root)).toBe(
      path.join('docs', 'prd', 'PRD-006-tracked.md'),
    );
  });

  it('makes an untracked PRD absolute — a worktree never receives it', () => {
    const { root } = repoWithPrds();
    const issue = makeIssue({ id: 'issue-01', project: 'PRD-009', prd: '.planning/PRD-009-local.md' });
    const worktree = path.join(root, 'not-a-real-worktree');
    const resolved = resolveIssuePrd(issue, { prdsDir: null, projects: {} }, worktree, root);
    expect(resolved).toBe(path.join(root, '.planning', 'PRD-009-local.md'));
    expect(path.isAbsolute(resolved!)).toBe(true);
  });
});
