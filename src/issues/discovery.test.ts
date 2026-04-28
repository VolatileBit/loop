import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverIssues, walkMarkdownFiles } from './discovery.js';
import { cleanupTempDirs, makeTempRoot, writeIssueFile } from './test-helpers.js';

afterEach(cleanupTempDirs);

describe('walkMarkdownFiles', () => {
  it('finds any *.md recursively except README.md, with no filename-pattern filter', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-001/anything-goes.md');
    writeIssueFile(root, 'issues/PRD-001/README.md');
    writeIssueFile(root, 'issues/README.md');
    writeIssueFile(root, 'issues/PRD-002/nested/deep-file.md');

    const files = walkMarkdownFiles(path.join(root, 'issues')).map((file) => path.relative(root, file));
    expect(files.sort()).toEqual(['issues/PRD-001/anything-goes.md', 'issues/PRD-002/nested/deep-file.md']);
  });

  it('returns [] for a missing directory', () => {
    expect(walkMarkdownFiles('/nonexistent/nowhere')).toEqual([]);
  });
});

describe('discoverIssues project and identity', () => {
  it('derives project from the immediate parent directory and computes qualifiedId', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-006/issue-07-timeouts.md', {
      frontmatter: { id: 'issue-07', title: 'Timeouts', triage: 'ready' },
      body: '## Blocked by\n\n- issue-02\n\n## Acceptance criteria\n\n- [ ] works\n',
    });

    const issues = discoverIssues('issues', root);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.id).toBe('issue-07');
    expect(issue.project).toBe('PRD-006');
    expect(issue.qualifiedId).toBe('PRD-006/issue-07');
    expect(issue.relPath).toBe('issues/PRD-006/issue-07-timeouts.md');
    expect(issue.blockedBy).toEqual(['issue-02']);
    expect(issue.acceptanceCriteria).toEqual(['- [ ] works']);
  });

  it('project is always the immediate parent, regardless of nesting depth', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-006/sub-area/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: 'ready' },
    });

    const issues = discoverIssues('issues', root);
    expect(issues[0]!.project).toBe('sub-area');
    expect(issues[0]!.qualifiedId).toBe('sub-area/issue-01');
  });

  it('allows the same local id across different projects', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', { frontmatter: { id: 'issue-01', triage: 'ready' } });
    writeIssueFile(root, 'issues/PRD-B/issue-01.md', { frontmatter: { id: 'issue-01', triage: 'ready' } });

    const issues = discoverIssues('issues', root);
    expect(issues.map((issue) => issue.qualifiedId)).toEqual(['PRD-A/issue-01', 'PRD-B/issue-01']);
  });

  it('fails fast on a duplicate qualifiedId, listing the colliding file paths', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01-first.md', { frontmatter: { id: 'issue-01', triage: 'ready' } });
    writeIssueFile(root, 'issues/PRD-A/issue-01-second.md', { frontmatter: { id: 'issue-01', triage: 'ready' } });

    expect(() => discoverIssues('issues', root)).toThrow(
      /Duplicate issue id[\s\S]*PRD-A\/issue-01[\s\S]*issue-01-first\.md[\s\S]*issue-01-second\.md/,
    );
  });

  it('fails fast when pre- and post-migration files share the same local id (rename collision)', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-001/ISSUE-001-01-old.md', { frontmatter: { id: 'issue-01', triage: 'ready' } });
    writeIssueFile(root, 'issues/PRD-001/issue-01-new.md', { frontmatter: { id: 'issue-01', triage: 'ready' } });

    expect(() => discoverIssues('issues', root)).toThrow(
      /Duplicate issue id[\s\S]*PRD-001\/issue-01[\s\S]*ISSUE-001-01-old\.md[\s\S]*issue-01-new\.md/,
    );
  });

  it('fails fast on a non-README *.md sitting directly in issuesDir with no project folder', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/stray-issue.md', { frontmatter: { id: 'issue-01', triage: 'ready' } });

    expect(() => discoverIssues('issues', root)).toThrow(/project subdirectory[\s\S]*stray-issue\.md/);
  });

  it('skips files with no resolvable id/issue frontmatter field', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/notes.md', { body: 'no frontmatter id here' });
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', { frontmatter: { id: 'issue-01', triage: 'ready' } });

    const issues = discoverIssues('issues', root);
    expect(issues.map((issue) => issue.qualifiedId)).toEqual(['PRD-A/issue-01']);
  });

  it('accepts the `issue` frontmatter field as an id alias', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/aliased.md', { frontmatter: { issue: 'issue-09', triage: 'ready' } });
    expect(discoverIssues('issues', root)[0]!.id).toBe('issue-09');
  });

  it('sorts by qualifiedId with numeric ordering', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-10.md', { frontmatter: { id: 'issue-10', triage: 'ready' } });
    writeIssueFile(root, 'issues/PRD-A/issue-2.md', { frontmatter: { id: 'issue-2', triage: 'ready' } });

    const issues = discoverIssues('issues', root);
    expect(issues.map((issue) => issue.id)).toEqual(['issue-2', 'issue-10']);
  });
});

describe('discoverIssues optional frontmatter fields', () => {
  it('captures prd and a valid lastStage; ignores an invalid lastStage', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/hotfixes/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: 'ready', prd: 'PRD-006', lastStage: 'reviewFix' },
    });
    writeIssueFile(root, 'issues/hotfixes/issue-02.md', {
      frontmatter: { id: 'issue-02', triage: 'ready', lastStage: 'not-a-stage' },
    });

    const issues = discoverIssues('issues', root);
    expect(issues[0]!.prd).toBe('PRD-006');
    expect(issues[0]!.lastStage).toBe('reviewFix');
    expect(issues[1]!.prd).toBeUndefined();
    expect(issues[1]!.lastStage).toBeUndefined();
  });
});
