import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_TRIAGE_LABELS } from '../config/triage-labels.js';
import type { LoopConfig } from '../config/types.js';
import { cleanupFixtureRepos, createFixtureRepo } from '../git/test-helpers.js';
import { discoverIssues } from '../issues/discovery.js';
import { archiveDateStamp, describeArchivePlan, executeArchive, planArchive } from './archive.js';

afterEach(cleanupFixtureRepos);

const LABELS = DEFAULT_TRIAGE_LABELS;
const NOW = new Date('2026-08-01T09:00:00Z');

type Setup = {
  root: string;
  config: Pick<LoopConfig, 'issuesDir' | 'projects' | 'archiveDir'>;
};

/** A repo with one project whose issues carry the given triage labels. */
function setup(triages: string[], overrides: Partial<Setup['config']> = {}): Setup {
  const root = createFixtureRepo('loop-archive-');
  mkdirSync(path.join(root, 'issues', 'PRD-006'), { recursive: true });
  triages.forEach((triage, index) => {
    const id = `issue-0${index + 1}`;
    writeFileSync(
      path.join(root, 'issues', 'PRD-006', `${id}.md`),
      `---\nid: ${id}\ntitle: Issue ${index + 1}\ntriage: ${triage}\n---\n\n## Acceptance criteria\n\n- [x] done\n`,
    );
  });
  return {
    root,
    config: { issuesDir: 'issues', projects: {}, archiveDir: 'docs/archive', ...overrides },
  };
}

function plan(setupResult: Setup) {
  return planArchive({
    root: setupResult.root,
    project: 'PRD-006',
    issues: discoverIssues(setupResult.config.issuesDir, setupResult.root),
    config: setupResult.config,
    labels: LABELS,
    now: NOW,
  });
}

describe('planArchive guards', () => {
  it('refuses without archiveDir — archiving moves real directories', () => {
    const result = plan(setup([LABELS.done], { archiveDir: null }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('archiveDir');
  });

  it('refuses while any issue would still be claimed by the next run', () => {
    const result = plan(setup([LABELS.done, LABELS.readyForAgent]));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('still runnable');
    expect(result.ok === false && result.details.join('\n')).toContain('PRD-006/issue-02');
  });

  it('allows a project whose remainder is only waiting on people', () => {
    // By the time someone retires a project, human-parked issues have usually
    // been handled outside loop; only work loop would re-claim is a blocker.
    const result = plan(setup([LABELS.done, LABELS.readyForHuman, LABELS.delegatedToHuman]));
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.plan.humanOwned).toEqual([
      'PRD-006/issue-02',
      'PRD-006/issue-03',
    ]);
  });

  it('never merges into an existing dated folder', () => {
    const fixture = setup([LABELS.done]);
    mkdirSync(path.join(fixture.root, 'docs/archive', `${archiveDateStamp(NOW)}-PRD-006`), {
      recursive: true,
    });
    const result = plan(fixture);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('already exists');
  });
});

describe('executeArchive', () => {
  function fullFixture(): Setup {
    const fixture = setup([LABELS.done], {
      projects: { 'PRD-006': { verifyCmd: 'npm test -- web' } },
    });
    mkdirSync(path.join(fixture.root, '.loop', 'runs', 'PRD-006'), { recursive: true });
    writeFileSync(path.join(fixture.root, '.loop', 'runs', 'PRD-006', 'summary.json'), '{}');
    mkdirSync(path.join(fixture.root, '.loop', 'handoffs', 'PRD-006'), { recursive: true });
    writeFileSync(path.join(fixture.root, '.loop', 'handoffs', 'PRD-006', 'issue-01.md'), 'notes');
    mkdirSync(path.join(fixture.root, '.loop', 'notes'), { recursive: true });
    writeFileSync(path.join(fixture.root, '.loop', 'notes', 'PRD-006.md'), '# notes');
    return fixture;
  }

  it('moves everything the project owns under one dated folder', () => {
    const fixture = fullFixture();
    const result = plan(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    executeArchive(fixture.root, result.plan);
    const dest = path.join(fixture.root, 'docs/archive', `${archiveDateStamp(NOW)}-PRD-006`);
    expect(existsSync(path.join(dest, 'issues', 'issue-01.md'))).toBe(true);
    expect(existsSync(path.join(dest, 'runs', 'summary.json'))).toBe(true);
    expect(existsSync(path.join(dest, 'handoffs', 'issue-01.md'))).toBe(true);
    expect(existsSync(path.join(dest, 'notes.md'))).toBe(true);

    // Sources are gone from their original homes, not copied.
    expect(existsSync(path.join(fixture.root, 'issues', 'PRD-006'))).toBe(false);
    expect(existsSync(path.join(fixture.root, '.loop', 'runs', 'PRD-006'))).toBe(false);
  });

  it('writes the config entry back as a valid partial config', () => {
    const fixture = fullFixture();
    const result = plan(fixture);
    if (!result.ok) throw new Error('expected a plan');

    executeArchive(fixture.root, result.plan);
    const dest = path.join(fixture.root, 'docs/archive', `${archiveDateStamp(NOW)}-PRD-006`);
    const written = JSON.parse(readFileSync(path.join(dest, 'loop.project.json'), 'utf8')) as unknown;
    // Restoring is a paste, not a transcription.
    expect(written).toEqual({ projects: { 'PRD-006': { verifyCmd: 'npm test -- web' } } });
  });

  it('leaves a sibling project untouched', () => {
    const fixture = fullFixture();
    mkdirSync(path.join(fixture.root, 'issues', 'PRD-007'), { recursive: true });
    writeFileSync(
      path.join(fixture.root, 'issues', 'PRD-007', 'issue-01.md'),
      `---\nid: issue-01\ntitle: Other\ntriage: ${LABELS.readyForAgent}\n---\n`,
    );
    const result = plan(fixture);
    if (!result.ok) throw new Error('expected a plan');

    executeArchive(fixture.root, result.plan);
    expect(existsSync(path.join(fixture.root, 'issues', 'PRD-007', 'issue-01.md'))).toBe(true);
    // The issues dir still holds a sibling, so it must not have been pruned.
    expect(existsSync(path.join(fixture.root, 'issues'))).toBe(true);
  });

  it('describes exactly what it will do, so dry-run and the real run agree', () => {
    const fixture = fullFixture();
    const result = plan(fixture);
    if (!result.ok) throw new Error('expected a plan');

    const lines = describeArchivePlan(fixture.root, result.plan).join('\n');
    expect(lines).toContain(path.join('docs', 'archive', `${archiveDateStamp(NOW)}-PRD-006`));
    expect(lines).toContain('issue files');
    expect(lines).toContain('project notes');
    expect(lines).toContain('loop.project.json');
  });
});

it('archives a nested planning project together with its spec and map', () => {
  const root = createFixtureRepo();
  const project = '20260913-gallery';
  const projectDir = path.join(root, 'specs', project);
  mkdirSync(path.join(projectDir, 'issues'), { recursive: true });
  mkdirSync(path.join(projectDir, 'map'));
  writeFileSync(path.join(projectDir, 'spec.md'), '# Gallery\n');
  writeFileSync(path.join(projectDir, 'map/01-format.md'), '# Formats\n');
  writeFileSync(path.join(projectDir, 'issues/01-upload.md'), '---\nid: 01-upload\ntriage: done\n---\n');
  const config = { issuesDir: 'specs', projects: {}, archiveDir: 'archive' };
  const result = planArchive({ root, project, config, issues: discoverIssues('specs', root), labels: LABELS, now: NOW });
  if (!result.ok) throw new Error(result.reason);
  executeArchive(root, result.plan);
  expect(readFileSync(path.join(result.plan.destination, 'planning/spec.md'), 'utf8')).toBe('# Gallery\n');
  expect(existsSync(path.join(result.plan.destination, 'planning/issues/01-upload.md'))).toBe(true);
  expect(existsSync(path.join(result.plan.destination, 'planning/map/01-format.md'))).toBe(true);
  expect(discoverIssues('specs', root)).toEqual([]);
});
