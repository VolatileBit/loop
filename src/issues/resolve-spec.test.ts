import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFixtureRepo, gitOrThrow } from '../git/test-helpers.js';
import { resolveIssueSpec } from './resolve-spec.js';
import { cleanupTempDirs, makeIssue, makeTempRoot } from './test-helpers.js';

import { cleanupFixtureRepos } from '../git/test-helpers.js';

afterEach(() => {
  cleanupTempDirs();
  cleanupFixtureRepos();
});

function makeSpecsRoot(files: string[]): string {
  const root = makeTempRoot('loop-spec-');
  mkdirSync(path.join(root, 'docs/specs'), { recursive: true });
  for (const name of files) writeFileSync(path.join(root, 'docs/specs', name), `# ${name}\n`);
  return root;
}

describe('resolveIssueSpec', () => {
  it('is disabled (null) when specsDir is unset', () => {
    const root = makeSpecsRoot(['PRD-006-loop-refactor.md']);
    const issue = makeIssue({ id: 'issue-07', project: 'PRD-006' });
    expect(resolveIssueSpec(issue, { specsDir: null, projects: {} }, root)).toBeNull();
  });

  it('matches issue.project against specsDir by case-insensitive filename prefix', () => {
    const root = makeSpecsRoot(['PRD-005-other.md', 'PRD-006-loop-refactor.md']);
    const issue = makeIssue({ id: 'issue-07', project: 'prd-006' });
    expect(resolveIssueSpec(issue, { specsDir: 'docs/specs', projects: {} }, root)).toBe(
      path.join('docs', 'specs', 'PRD-006-loop-refactor.md'),
    );
  });

  it('requires a boundary after the prefix (PRD-006 must not match PRD-0061-*)', () => {
    const root = makeSpecsRoot(['PRD-0061-lookalike.md']);
    const issue = makeIssue({ id: 'issue-01', project: 'PRD-006' });
    expect(resolveIssueSpec(issue, { specsDir: 'docs/specs', projects: {} }, root)).toBeNull();
  });

  it('honors an explicit spec: frontmatter override as a filename prefix', () => {
    const root = makeSpecsRoot(['PRD-006-loop-refactor.md', 'PRD-004-other.md']);
    const issue = makeIssue({ id: 'issue-01', project: 'hotfixes', spec: 'PRD-006' });
    expect(resolveIssueSpec(issue, { specsDir: 'docs/specs', projects: {} }, root)).toBe(
      path.join('docs', 'specs', 'PRD-006-loop-refactor.md'),
    );
  });

  it('honors an explicit spec: frontmatter override as a repo-relative path', () => {
    const root = makeSpecsRoot(['PRD-006-loop-refactor.md']);
    const issue = makeIssue({
      id: 'issue-01',
      project: 'hotfixes',
      spec: 'docs/specs/PRD-006-loop-refactor.md',
    });
    expect(resolveIssueSpec(issue, { specsDir: 'docs/specs', projects: {} }, root)).toBe(
      path.join('docs', 'specs', 'PRD-006-loop-refactor.md'),
    );
  });

  it('honors a projects.<name>.spec config override (prefix or path), below frontmatter', () => {
    const root = makeSpecsRoot(['PRD-006-loop-refactor.md', 'PRD-004-other.md']);
    const projects = { hotfixes: { spec: 'PRD-006' } };

    // Project config override applies when frontmatter has none.
    const fromConfig = makeIssue({ id: 'issue-01', project: 'hotfixes' });
    expect(resolveIssueSpec(fromConfig, { specsDir: 'docs/specs', projects }, root)).toBe(
      path.join('docs', 'specs', 'PRD-006-loop-refactor.md'),
    );

    // Frontmatter spec: beats the project config.
    const fromFrontmatter = makeIssue({ id: 'issue-02', project: 'hotfixes', spec: 'PRD-004' });
    expect(resolveIssueSpec(fromFrontmatter, { specsDir: 'docs/specs', projects }, root)).toBe(
      path.join('docs', 'specs', 'PRD-004-other.md'),
    );

    // A path-style project override works even without specsDir.
    const pathOverride = { docs: { spec: 'docs/specs/PRD-004-other.md' } };
    const fromPath = makeIssue({ id: 'issue-03', project: 'docs' });
    expect(resolveIssueSpec(fromPath, { specsDir: null, projects: pathOverride }, root)).toBe(
      path.join('docs', 'specs', 'PRD-004-other.md'),
    );
  });

  it('returns null (never throws) when nothing matches or specsDir is missing', () => {
    const root = makeSpecsRoot(['PRD-001-unrelated.md']);
    const noMatch = makeIssue({ id: 'issue-01', project: 'PRD-999' });
    expect(resolveIssueSpec(noMatch, { specsDir: 'docs/specs', projects: {} }, root)).toBeNull();

    const badOverride = makeIssue({ id: 'issue-02', project: 'PRD-001', spec: 'PRD-404' });
    expect(resolveIssueSpec(badOverride, { specsDir: 'docs/specs', projects: {} }, root)).toBeNull();

    const missingDir = makeIssue({ id: 'issue-03', project: 'PRD-001' });
    expect(resolveIssueSpec(missingDir, { specsDir: 'no/such/dir', projects: {} }, root)).toBeNull();
  });
});

describe('resolveIssueSpec across worktrees', () => {
  /** A repo with one tracked spec and one in a gitignored directory. */
  function repoWithSpecs(): { root: string } {
    const root = createFixtureRepo('loop-prd-worktree-');
    mkdirSync(path.join(root, 'docs/specs'), { recursive: true });
    mkdirSync(path.join(root, '.planning'), { recursive: true });
    writeFileSync(path.join(root, 'docs/specs/PRD-006-tracked.md'), '# tracked\n');
    writeFileSync(path.join(root, '.planning/PRD-009-local.md'), '# untracked\n');
    writeFileSync(path.join(root, '.gitignore'), '.planning/\n');
    gitOrThrow(['add', '.'], root);
    gitOrThrow(['commit', '-m', 'chore: add specs'], root);
    return { root };
  }

  it('keeps a tracked spec relative, since every worktree receives it', () => {
    const { root } = repoWithSpecs();
    const issue = makeIssue({ id: 'issue-01', project: 'PRD-006' });
    expect(resolveIssueSpec(issue, { specsDir: 'docs/specs', projects: {} }, root)).toBe(
      path.join('docs', 'specs', 'PRD-006-tracked.md'),
    );
  });

  it('makes an untracked spec absolute — a worktree never receives it', () => {
    const { root } = repoWithSpecs();
    const issue = makeIssue({ id: 'issue-01', project: 'PRD-009', spec: '.planning/PRD-009-local.md' });
    const worktree = path.join(root, 'not-a-real-worktree');
    const resolved = resolveIssueSpec(issue, { specsDir: null, projects: {} }, worktree, root);
    expect(resolved).toBe(path.join(root, '.planning', 'PRD-009-local.md'));
    expect(path.isAbsolute(resolved!)).toBe(true);
  });
});

describe('planning spec folders', () => {
  it('resolves a project spec.md and preserves explicit override precedence', () => {
    const root = makeSpecsRoot(['other.md']);
    mkdirSync(path.join(root, 'docs/specs/image-previews'), { recursive: true });
    writeFileSync(path.join(root, 'docs/specs/image-previews/spec.md'), '# Preview spec\n');
    const config = { specsDir: 'docs/specs', projects: {} };
    expect(resolveIssueSpec(makeIssue({ project: 'image-previews' }), config, root)).toBe('docs/specs/image-previews/spec.md');
    expect(resolveIssueSpec(makeIssue({ project: 'image-previews', spec: 'missing.md' }), config, root)).toBeNull();
    expect(resolveIssueSpec(makeIssue({ project: 'image-previews', spec: 'docs/specs/other.md' }), config, root)).toBe('docs/specs/other.md');
  });

  it('does not silently choose between competing implicit specs', () => {
    const root = makeSpecsRoot(['image-previews.md', 'image-previews-notes.md']);
    const issue = makeIssue({ project: 'image-previews' });
    expect(resolveIssueSpec(issue, { specsDir: 'docs/specs', projects: {} }, root)).toBeNull();
    expect(resolveIssueSpec(issue, { specsDir: 'docs/specs', projects: { 'image-previews': { spec: 'docs/specs/image-previews.md' } } }, root)).toBe('docs/specs/image-previews.md');
  });
});
