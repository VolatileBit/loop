import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverIssues } from './discovery.js';
import { clearIssueStage, resolveResumeStage, setIssueStage } from './resolve-resume-stage.js';
import { cleanupTempDirs, LABELS, makeIssue, makeTempRoot, writeIssueFile } from './test-helpers.js';

afterEach(cleanupTempDirs);

describe('resolveResumeStage', () => {
  it('resumes at lastStage for every runnable role', () => {
    for (const triage of [
      LABELS.readyForAgent,
      LABELS.inProgress,
      LABELS.verifyFailed,
      LABELS.agentFailed,
      LABELS.agentInterrupted,
    ]) {
      const issue = makeIssue({ id: 'issue-01', triage, lastStage: 'reviewFix' });
      expect(resolveResumeStage(issue, LABELS)).toBe('reviewFix');
    }
  });

  it('ignores checkpoints for non-runnable roles', () => {
    for (const triage of [LABELS.needsTriage, LABELS.readyForHuman]) {
      const issue = makeIssue({ id: 'issue-01', triage, lastStage: 'review' });
      expect(resolveResumeStage(issue, LABELS)).toBe('implement');
    }
  });

  it('starts at implement when a failure role has no checkpoint', () => {
    const issue = makeIssue({ id: 'issue-01', triage: LABELS.agentFailed });
    expect(resolveResumeStage(issue, LABELS)).toBe('implement');
  });
});

describe('setIssueStage / clearIssueStage', () => {
  function discoverOne(root: string) {
    const issue = discoverIssues('issues', root)[0];
    expect(issue).toBeDefined();
    return issue!;
  }

  it('inserts a lastStage field into frontmatter when absent', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: 'ready' },
      body: '## Context\n\nBody stays intact.\n',
    });
    const issue = discoverOne(root);

    setIssueStage(issue, 'verifyFix');

    expect(issue.lastStage).toBe('verifyFix');
    const content = readFileSync(issue.filePath, 'utf8');
    expect(content).toMatch(/^---\n[\s\S]*lastStage: verifyFix\n---\n/);
    expect(content).toContain('Body stays intact.');
    // Round-trips through discovery.
    expect(discoverOne(root).lastStage).toBe('verifyFix');
  });

  it('updates an existing lastStage field in place', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: 'ready', lastStage: 'implement' },
    });
    const issue = discoverOne(root);

    setIssueStage(issue, 'review');

    const content = readFileSync(issue.filePath, 'utf8');
    expect(content).toContain('lastStage: review');
    expect(content).not.toContain('lastStage: implement');
  });

  it('clearIssueStage removes the field from file and record; no-op when absent', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: 'ready', lastStage: 'reviewFix' },
    });
    const issue = discoverOne(root);

    clearIssueStage(issue);
    expect(issue.lastStage).toBeUndefined();
    expect(readFileSync(issue.filePath, 'utf8')).not.toContain('lastStage:');

    // Second clear is harmless.
    const before = readFileSync(issue.filePath, 'utf8');
    clearIssueStage(issue);
    expect(readFileSync(issue.filePath, 'utf8')).toBe(before);
  });
});
