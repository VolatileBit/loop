import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveTriageLabels } from '../config/triage-labels.js';
import { discoverIssues } from './discovery.js';
import {
  isDone,
  isRunnableTriage,
  isSelfReportedComplete,
  isSettled,
  issueTriageRole,
  issuesWithUnknownTriage,
  markInProgress,
  setIssueTriage,
} from './lifecycle.js';
import { cleanupTempDirs, LABELS, makeIssue, makeTempRoot, writeIssueFile } from './test-helpers.js';

afterEach(cleanupTempDirs);

const PINNED = resolveTriageLabels({
  triageLabels: { readyForAgent: 'ready-for-agent', done: 'agent-done', readyForHuman: 'ready-for-human' },
});

describe('isDone / isSelfReportedComplete (role-based)', () => {
  it('is false when triage is verify-failed even if all criteria are checked', () => {
    const record = makeIssue({
      id: 'issue-06',
      triage: LABELS.verifyFailed,
      acceptanceCriteria: ['- [x] one', '- [x] two'],
    });
    expect(isDone(record, LABELS)).toBe(false);
    expect(isSelfReportedComplete(record, LABELS)).toBe(true);
  });

  it('is true only when triage carries the done role', () => {
    const done = makeIssue({ id: 'issue-01', triage: LABELS.done, acceptanceCriteria: ['- [x] one'] });
    const ready = makeIssue({ id: 'issue-02', triage: LABELS.readyForAgent, acceptanceCriteria: ['- [x] one'] });
    expect(isDone(done, LABELS)).toBe(true);
    expect(isDone(ready, LABELS)).toBe(false);
  });

  it('honors configured label strings, not literals', () => {
    const done = makeIssue({ id: 'issue-01', triage: 'agent-done' });
    expect(isDone(done, PINNED)).toBe(true);
    expect(isDone(done, LABELS)).toBe(false); // 'agent-done' is not the generic default done label
  });
});

describe('isRunnableTriage', () => {
  it('accepts exactly the runnable roles under the active vocabulary', () => {
    for (const label of [
      LABELS.readyForAgent,
      LABELS.inProgress,
      LABELS.verifyFailed,
      LABELS.agentFailed,
      LABELS.agentInterrupted,
    ]) {
      expect(isRunnableTriage(label, LABELS)).toBe(true);
    }
    for (const label of [
      LABELS.done,
      LABELS.readyForHuman,
      LABELS.delegatedToHuman,
      LABELS.needsTriage,
      LABELS.needsInfo,
      LABELS.wontfix,
      'unknown',
    ]) {
      expect(isRunnableTriage(label, LABELS)).toBe(false);
    }
  });

  it('follows the configured vocabulary', () => {
    expect(isRunnableTriage('ready-for-agent', PINNED)).toBe(true);
    expect(isRunnableTriage('ready-for-agent', LABELS)).toBe(false);
  });
});

describe('setIssueTriage / markInProgress', () => {
  function discoverOne(root: string) {
    const issue = discoverIssues('issues', root)[0];
    expect(issue).toBeDefined();
    return issue!;
  }

  it('writes the configured label for the role into the file and the record', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: 'ready-for-agent' },
    });
    const issue = discoverOne(root);

    setIssueTriage(issue, 'verifyFailed', PINNED);

    expect(issue.triage).toBe('verify-failed');
    expect(readFileSync(issue.filePath, 'utf8')).toContain('triage: verify-failed');
    expect(issueTriageRole(issue, PINNED)).toBe('verifyFailed');
  });

  it('clears the lastStage checkpoint when triage becomes done', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: 'verify-failed', lastStage: 'verifyFix' },
    });
    const issue = discoverOne(root);
    expect(issue.lastStage).toBe('verifyFix');

    setIssueTriage(issue, 'done', LABELS);

    expect(issue.lastStage).toBeUndefined();
    const content = readFileSync(issue.filePath, 'utf8');
    expect(content).toContain(`triage: ${LABELS.done}`);
    expect(content).not.toContain('lastStage:');
  });

  it('keeps the lastStage checkpoint when a human resets triage to readyForAgent', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: LABELS.readyForHuman, lastStage: 'reviewFix' },
    });
    const issue = discoverOne(root);

    setIssueTriage(issue, 'readyForAgent', LABELS);

    expect(issue.lastStage).toBe('reviewFix');
    expect(readFileSync(issue.filePath, 'utf8')).toContain('lastStage: reviewFix');
  });

  it('keeps the lastStage checkpoint for failure-role transitions', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: 'in-progress', lastStage: 'review' },
    });
    const issue = discoverOne(root);

    setIssueTriage(issue, 'agentFailed', LABELS);

    expect(issue.lastStage).toBe('review');
    expect(readFileSync(issue.filePath, 'utf8')).toContain('lastStage: review');
  });

  it('markInProgress is a no-op when already in progress', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: LABELS.inProgress },
    });
    const issue = discoverOne(root);
    const before = readFileSync(issue.filePath, 'utf8');

    markInProgress(issue, LABELS);
    expect(readFileSync(issue.filePath, 'utf8')).toBe(before);

    setIssueTriage(issue, 'readyForAgent', LABELS);
    markInProgress(issue, LABELS);
    expect(issue.triage).toBe(LABELS.inProgress);
  });
});

describe('isSettled', () => {
  it('settles the roles loop is not waiting on anyone for', () => {
    for (const label of [LABELS.done, LABELS.wontfix, LABELS.delegatedToHuman]) {
      expect(isSettled(makeIssue({ id: 'issue-01', triage: label }), LABELS)).toBe(true);
    }
  });

  it('does not settle roles that are waiting on a person', () => {
    for (const label of [LABELS.readyForHuman, LABELS.needsInfo, LABELS.needsTriage, LABELS.readyForAgent]) {
      expect(isSettled(makeIssue({ id: 'issue-01', triage: label }), LABELS)).toBe(false);
    }
  });

  it('distinguishes work a person took on from work loop got stuck on', () => {
    // Both are non-runnable, but only one means loop is still owed something.
    const delegated = makeIssue({ id: 'issue-01', triage: LABELS.delegatedToHuman });
    const escalated = makeIssue({ id: 'issue-02', triage: LABELS.readyForHuman });
    expect(isRunnableTriage(delegated.triage, LABELS)).toBe(false);
    expect(isRunnableTriage(escalated.triage, LABELS)).toBe(false);
    expect(isSettled(delegated, LABELS)).toBe(true);
    expect(isSettled(escalated, LABELS)).toBe(false);
  });
});

describe('issuesWithUnknownTriage', () => {
  it('names issues that would otherwise vanish from the backlog silently', () => {
    const typo = makeIssue({ id: 'issue-01', triage: 'redy' });
    const fine = makeIssue({ id: 'issue-02', triage: LABELS.readyForAgent });
    expect(issuesWithUnknownTriage([typo, fine], LABELS)).toEqual([typo]);
  });

  it('judges against the configured vocabulary, not the defaults', () => {
    const issue = makeIssue({ id: 'issue-01', triage: 'ready' });
    expect(issuesWithUnknownTriage([issue], LABELS)).toEqual([]);
    expect(issuesWithUnknownTriage([issue], PINNED)).toEqual([issue]);
  });
});
