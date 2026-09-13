import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupFixtureRepos, createFixtureRepo } from '../git/test-helpers.js';
import { parseCliArgs } from '../cli/args.js';
import { ensureRuntimeStateIgnored, mergeInitConfig, parseDiscoveryReport } from './init.js';

afterEach(cleanupFixtureRepos);

it('accepts canonical init flags and the old input aliases', () => {
  const canonical = parseCliArgs(['init', '--specs-dir', 'specs', '--project', 'gallery', '--project-spec', 'specs/gallery/spec.md'], {});
  const legacy = parseCliArgs(['init', '--prds-dir', 'specs', '--project', 'gallery', '--project-prd', 'specs/gallery/spec.md'], {});
  expect(canonical).toMatchObject({ command: 'init', flags: { specsDir: 'specs', projectSpec: 'specs/gallery/spec.md' } });
  expect(legacy).toEqual(canonical);
});

it('writes canonical names when extending an older tracked config', () => {
  const existing = { prdsDir: 'docs/prd', projects: { gallery: { prd: 'docs/prd/gallery.md', verifyCmd: 'make check' } } };
  const answers = { agentCli: 'codex' as const, verifyCmd: null, issuesDir: null, specsDir: null, project: null };
  const result = mergeInitConfig(existing, answers);
  expect(result.config).toEqual({ agentCli: 'codex', specsDir: 'docs/prd',
    projects: { gallery: { spec: 'docs/prd/gallery.md', verifyCmd: 'make check' } } });
  expect(existing).toHaveProperty('prdsDir', 'docs/prd');
  expect(result.written).toContain('specsDir');
  expect(result.written).toContain('projects.gallery.spec');
});

describe('parseDiscoveryReport', () => {
  it('parses the discovery block, mapping "none" to null', () => {
    const text = [
      'I inspected the repo.',
      '',
      '## Loop discovery',
      'verify: pnpm typecheck && pnpm test',
      'issues-dir: none',
      'specs-dir: docs/specs',
    ].join('\n');
    expect(parseDiscoveryReport(text)).toEqual({
      verifyCmd: 'pnpm typecheck && pnpm test',
      issuesDir: null,
      specsDir: 'docs/specs',
    });
  });

  it('degrades to an empty report when the block is missing', () => {
    expect(parseDiscoveryReport('no block here')).toEqual({ verifyCmd: null, issuesDir: null, specsDir: null });
  });
});

describe('mergeInitConfig', () => {
  const ANSWERS = {
    agentCli: 'claude-code' as const,
    verifyCmd: 'pnpm verify',
    issuesDir: 'work/issues',
    specsDir: 'docs/specs',
    project: null,
  };

  it('writes answered keys into an empty config', () => {
    const merged = mergeInitConfig({}, ANSWERS);
    expect(merged.config).toEqual({
      agentCli: 'claude-code',
      verifyCmd: 'pnpm verify',
      issuesDir: 'work/issues',
      specsDir: 'docs/specs',
    });
    expect(merged.written.sort()).toEqual(['agentCli', 'issuesDir', 'specsDir', 'verifyCmd']);
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
    const merged = mergeInitConfig({}, { ...ANSWERS, issuesDir: 'issues', specsDir: null });
    expect(merged.config).not.toHaveProperty('issuesDir');
    expect(merged.config).not.toHaveProperty('specsDir');
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

it('keeps projects from both tracked and local configuration on repeated init', () => {
  const tracked = { projects: { existing: { verifyCmd: 'npm test' } } };
  const effective = { projects: { existing: { verifyCmd: 'npm test' }, local: { spec: 'local.md' } } };
  const answers = { agentCli: 'codex' as const, verifyCmd: null, issuesDir: null, specsDir: null, project: null,
    projects: [{ name: 'new', spec: 'specs/new/spec.md' }] };
  const merged = mergeInitConfig(tracked, answers, effective);
  expect(merged.config.projects).toEqual({ existing: { verifyCmd: 'npm test' }, new: { spec: 'specs/new/spec.md' } });
  expect(() => mergeInitConfig(tracked, { ...answers, projects: [{ name: 'local' }] }, effective)).toThrow(/already exists/);
  expect(() => mergeInitConfig(merged.config, answers)).toThrow(/already exists/);
});
