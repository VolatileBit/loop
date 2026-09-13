import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Asker } from '../cli/ask.js';
import type { InitFlags } from '../cli/args.js';
import { loadConfig, mergeRawConfigs } from '../config/load-config.js';
import { resolveTriageLabels } from '../config/triage-labels.js';
import { cleanupFixtureRepos, createFixtureRepo } from '../git/test-helpers.js';
import { discoverIssues } from '../issues/discovery.js';
import { setIssueTriage } from '../issues/lifecycle.js';
import { pickNextIssue } from '../issues/scheduling.js';
import { resolveIssueSpec } from '../issues/resolve-spec.js';
import { discoverPlanningPaths, discoverPlanningProjects, gatherPlanningAnswers } from './init-planning.js';
import { mergeInitConfig } from './init.js';

afterEach(cleanupFixtureRepos);
const FLAGS: InitFlags = { interactive: true, noDiscovery: true, quiet: true, help: false };
function write(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}
function script(answers: string[]): Asker {
  return { question: async () => {
    const answer = answers.shift();
    if (answer === undefined) throw new Error('Unexpected setup question');
    return answer;
  }, close() {} };
}
function fixture() {
  const root = createFixtureRepo();
  // Use the actual shipped planning example, rather than a second invented format.
  const contract = readFileSync(new URL('../skills/planning/to-spec/references/loop-planning.md', import.meta.url), 'utf8');
  const issue = contract.match(/```markdown\n([\s\S]*?)```/)![1]!;
  write(root, 'specs/20260913-image-previews/issues/01-upload.md', issue);
  write(root, 'specs/20260913-image-previews/spec.md', '# Image previews\n\n## Testing Decisions\nUpload API integration tests.\n');
  write(root, 'specs/20260913-image-previews/map/01-format.md', '# Decide supported formats\nStatus: open\n');
  return { root, issue };
}

describe('planning output to Loop', () => {
  it('defaults an empty repository to the shared specs root', async () => {
    const root = createFixtureRepo();
    const planning = await gatherPlanningAnswers(root, script(['', '', 'n']), FLAGS, {}, { issuesDir: null, specsDir: null });
    expect(planning).toEqual({ issuesDir: 'specs', specsDir: 'specs', projects: [] });
  });

  it('suggests a custom planning root and registers a spec before issues exist', async () => {
    const root = createFixtureRepo();
    write(root, 'planning/features/20260913-image-previews/spec.md', '# Image previews\n');
    const planning = await gatherPlanningAnswers(root, script(['', '', '', '', '', 'n']), FLAGS, {}, { issuesDir: null, specsDir: null });
    expect(planning).toEqual({ issuesDir: 'planning/features', specsDir: 'planning/features',
      projects: [{ name: '20260913-image-previews', spec: 'planning/features/20260913-image-previews/spec.md' }] });
  });

  it('initializes from the shipped example, resolves its spec, and schedules only implementation work', async () => {
    const { root } = fixture();
    const answers = ['', '', '', '', '', 'n']; // roots, register, spec, inherit verify, custom project
    const planning = await gatherPlanningAnswers(root, script(answers), FLAGS, {}, { issuesDir: null, specsDir: null });
    expect(answers).toEqual([]);
    expect(planning.projects).toEqual([{ name: '20260913-image-previews', spec: 'specs/20260913-image-previews/spec.md' }]);
    const merged = mergeInitConfig({}, { agentCli: 'codex', verifyCmd: 'npm test', project: null, ...planning });
    write(root, 'loop.config.json', JSON.stringify(merged.config));
    const config = loadConfig(root);
    const issues = discoverIssues(config.issuesDir, root);
    expect(issues.map((issue) => issue.qualifiedId)).toEqual(['20260913-image-previews/01-upload']);
    expect(issues[0]!.acceptanceCriteria).toHaveLength(2);
    expect(pickNextIssue(issues, resolveTriageLabels(config))?.title).toBe('Accept an image upload');
    expect(resolveIssueSpec(issues[0]!, config, root)).toBe(path.join(root, 'specs/20260913-image-previews/spec.md'));
  });

  it('keeps human dependencies blocked until a person marks them done', () => {
    const { root, issue } = fixture();
    write(root, 'specs/20260913-image-previews/issues/01-upload.md', issue.replace('## Blocked by\n\nNone', '## Blocked by\n\n- 00-select-formats'));
    write(root, 'specs/20260913-image-previews/issues/00-select-formats.md', '---\nid: 00-select-formats\ntitle: Choose supported formats\ntriage: delegated\n---\n\n## Done when\nFormats recorded in the spec.\n');
    const issues = discoverIssues('specs', root);
    const labels = resolveTriageLabels({});
    expect(pickNextIssue(issues, labels)).toBeNull();
    setIssueTriage(issues[0]!, 'done', labels);
    expect(pickNextIssue(discoverIssues('specs', root), labels)?.id).toBe('01-upload');
  });

  it('finds custom roots and offers only projects missing from both config files', async () => {
    const { root, issue } = fixture();
    write(root, 'work/tickets/new-project/01-upload.md', issue.replace('specs/20260913-image-previews/spec.md', 'design/new-project/spec.md'));
    write(root, 'design/new-project/spec.md', '# New project\n');
    const paths = discoverPlanningPaths(root);
    expect(paths.issuesDirs).toContain('work/tickets');
    expect(paths.specsDirs).toContain('design');
    const effective = mergeRawConfigs({ projects: { '20260913-image-previews': {} } }, { projects: { local: {} } });
    expect(discoverPlanningProjects(root, 'specs', 'specs', effective.projects as Record<string, unknown>)).toEqual([]);
    const planning = await gatherPlanningAnswers(root, script(['', '', 'n']), {
      ...FLAGS, issuesDir: 'work/tickets', specsDir: 'design', project: 'new-project',
    }, effective, { issuesDir: null, specsDir: null });
    expect(planning).toEqual({ issuesDir: 'work/tickets', specsDir: 'design', projects: [{ name: 'new-project', spec: 'design/new-project/spec.md' }] });
  });

  it('allows replacing suggested roots and spec paths', async () => {
    const { root } = fixture();
    write(root, 'custom-doc.md', '# Custom spec\n');
    const planning = await gatherPlanningAnswers(root, script(['custom/tasks', 'custom/specs', 'y', 'custom-project', 'custom-doc.md', 'none']), FLAGS, {}, { issuesDir: null, specsDir: null });
    expect(planning).toEqual({ issuesDir: 'custom/tasks', specsDir: 'custom/specs', projects: [{ name: 'custom-project', spec: 'custom-doc.md' }] });
  });

  it('registers several discovered projects without overwriting an existing entry', async () => {
    const { root } = fixture();
    write(root, 'specs/future-work/spec.md', '# Future work\n');
    const planning = await gatherPlanningAnswers(root, script(['', '', '', '', '', '', 'n']), FLAGS,
      { issuesDir: 'specs', specsDir: 'specs', projects: { established: { verifyCmd: 'make check' } } }, { issuesDir: null, specsDir: null });
    expect(planning.projects.map((project) => project.name)).toEqual(['20260913-image-previews', 'future-work']);
    const result = mergeInitConfig({ projects: { established: { verifyCmd: 'make check' } } }, {
      agentCli: 'codex', verifyCmd: 'npm test', project: null, ...planning,
    });
    expect(result.config.projects).toEqual({ established: { verifyCmd: 'make check' }, 'future-work': { spec: 'specs/future-work/spec.md' }, '20260913-image-previews': { spec: 'specs/20260913-image-previews/spec.md' } });
  });
});

it('does not rediscover registered flat specs or intermediate issue folders as new projects', () => {
  const root = createFixtureRepo();
  write(root, 'specs/known-project-design.md', '# Known spec\n');
  write(root, 'specs/new-project.md', '# New spec\n');
  write(root, 'issues/group/leaf/01-task.md', '---\nid: 01-task\ntriage: ready\n---\n');
  expect(discoverPlanningProjects(root, 'issues', 'specs', { 'known-project': {} })).toEqual([
    { name: 'leaf', specs: [] },
    { name: 'new-project', specs: ['specs/new-project.md'] },
  ]);
});
