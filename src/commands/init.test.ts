import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupFixtureRepos, createFixtureRepo } from '../git/test-helpers.js';
import { ensureRuntimeStateIgnored, mergeInitConfig, parseDiscoveryReport } from './init.js';

afterEach(cleanupFixtureRepos);

describe('parseDiscoveryReport', () => {
  it('parses the discovery block, mapping "none" to null', () => {
    const text = [
      'I inspected the repo.',
      '',
      '## Loop discovery',
      'verify: pnpm typecheck && pnpm test',
      'issues-dir: none',
      'prds-dir: docs/prd',
    ].join('\n');
    expect(parseDiscoveryReport(text)).toEqual({
      verifyCmd: 'pnpm typecheck && pnpm test',
      issuesDir: null,
      prdsDir: 'docs/prd',
    });
  });

  it('degrades to an empty report when the block is missing', () => {
    expect(parseDiscoveryReport('no block here')).toEqual({ verifyCmd: null, issuesDir: null, prdsDir: null });
  });
});

describe('mergeInitConfig', () => {
  const ANSWERS = {
    agentCli: 'claude-code' as const,
    verifyCmd: 'pnpm verify',
    issuesDir: 'work/issues',
    prdsDir: 'docs/prd',
    project: null,
  };

  it('writes answered keys into an empty config', () => {
    const merged = mergeInitConfig({}, ANSWERS);
    expect(merged.config).toEqual({
      agentCli: 'claude-code',
      verifyCmd: 'pnpm verify',
      issuesDir: 'work/issues',
      prdsDir: 'docs/prd',
    });
    expect(merged.written.sort()).toEqual(['agentCli', 'issuesDir', 'prdsDir', 'verifyCmd']);
    expect(merged.kept).toEqual([]);
  });

  it('never clobbers existing values and reports them as kept', () => {
    const merged = mergeInitConfig({ verifyCmd: 'make check', maxParallelRuns: 2 }, ANSWERS);
    expect(merged.config.verifyCmd).toBe('make check');
    expect(merged.config.maxParallelRuns).toBe(2);
    expect(merged.kept).toContain('verifyCmd');
    expect(merged.written).toContain('agentCli');
  });

  it('omits the default issues dir instead of writing noise', () => {
    const merged = mergeInitConfig({}, { ...ANSWERS, issuesDir: 'issues', prdsDir: null });
    expect(merged.config).not.toHaveProperty('issuesDir');
    expect(merged.config).not.toHaveProperty('prdsDir');
  });

  it('adds new projects entries but refuses to overwrite existing ones', () => {
    const withProject = mergeInitConfig(
      { verifyCmd: 'pnpm verify' },
      { ...ANSWERS, project: { name: 'PRD-006', verifyCmd: 'pnpm --filter web verify' } },
    );
    expect(withProject.config.projects).toEqual({ 'PRD-006': { verifyCmd: 'pnpm --filter web verify' } });
    expect(withProject.written).toContain('projects.PRD-006');

    expect(() =>
      mergeInitConfig(
        { projects: { 'PRD-006': { verifyCmd: 'old' } } },
        { ...ANSWERS, project: { name: 'PRD-006', verifyCmd: 'new' } },
      ),
    ).toThrow(/never overwrites an existing project entry/);
  });
});

describe('ensureRuntimeStateIgnored', () => {
  it('adds both runtime paths to a repo that ignores neither', () => {
    const root = createFixtureRepo('loop-init-ignore-');
    expect(ensureRuntimeStateIgnored(root)).toEqual(['.loop/', 'loop.config.local.json']);
    const gitignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.loop/');
    expect(gitignore).toContain('loop.config.local.json');
  });

  it('leaves a repo alone that already covers them by any mechanism', () => {
    const root = createFixtureRepo('loop-init-ignore-covered-');
    // A broad pattern counts: git check-ignore is the question, not a text match.
    writeFileSync(path.join(root, '.gitignore'), '.loop*\nloop.config.local.json\n');
    expect(ensureRuntimeStateIgnored(root)).toEqual([]);
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('.loop*\nloop.config.local.json\n');
  });

  it('adds only what is missing, preserving existing rules', () => {
    const root = createFixtureRepo('loop-init-ignore-partial-');
    writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.loop/\n');
    expect(ensureRuntimeStateIgnored(root)).toEqual(['loop.config.local.json']);
    const gitignore = readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('loop.config.local.json');
  });

  it('does not glue its block onto a file with no trailing newline', () => {
    const root = createFixtureRepo('loop-init-ignore-nonewline-');
    writeFileSync(path.join(root, '.gitignore'), 'dist');
    ensureRuntimeStateIgnored(root);
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).not.toContain('dist\n# loop');
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8').startsWith('dist\n')).toBe(true);
  });
});
