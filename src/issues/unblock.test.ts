import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverIssues } from './discovery.js';
import { cleanupTempDirs, LABELS, makeTempRoot, writeIssueFile } from './test-helpers.js';
import { unblockNeedsHumanIssues } from './unblock.js';

afterEach(cleanupTempDirs);

function setupIssues() {
  const root = makeTempRoot();
  writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
    frontmatter: { id: 'issue-01', triage: LABELS.readyForHuman, lastStage: 'verifyFix' },
  });
  writeIssueFile(root, 'issues/PRD-A/issue-02.md', {
    frontmatter: { id: 'issue-02', triage: LABELS.readyForHuman, lastStage: 'reviewFix' },
  });
  writeIssueFile(root, 'issues/PRD-B/issue-01.md', {
    frontmatter: { id: 'issue-01', triage: LABELS.readyForHuman },
  });
  writeIssueFile(root, 'issues/PRD-B/issue-02.md', {
    frontmatter: { id: 'issue-02', triage: LABELS.readyForAgent },
  });
  return { root, issues: discoverIssues('issues', root) };
}

describe('unblockNeedsHumanIssues', () => {
  it('maps verifyFix to verifyFailed and everything else to agentFailed', () => {
    const { root, issues } = setupIssues();

    const transitions = unblockNeedsHumanIssues(issues, null, { labels: LABELS });

    expect(transitions).toEqual([
      {
        qualifiedId: 'PRD-A/issue-01',
        fromLabel: LABELS.readyForHuman,
        toRole: 'verifyFailed',
        toLabel: LABELS.verifyFailed,
        resumeStage: 'verifyFix',
      },
      {
        qualifiedId: 'PRD-A/issue-02',
        fromLabel: LABELS.readyForHuman,
        toRole: 'agentFailed',
        toLabel: LABELS.agentFailed,
        resumeStage: 'reviewFix',
      },
      {
        qualifiedId: 'PRD-B/issue-01',
        fromLabel: LABELS.readyForHuman,
        toRole: 'agentFailed',
        toLabel: LABELS.agentFailed,
        resumeStage: 'implement',
      },
    ]);

    // Frontmatter was rewritten to the runnable failure labels.
    const after = discoverIssues('issues', root);
    expect(after.find((i) => i.qualifiedId === 'PRD-A/issue-01')?.triage).toBe(LABELS.verifyFailed);
    expect(after.find((i) => i.qualifiedId === 'PRD-A/issue-02')?.triage).toBe(LABELS.agentFailed);
    expect(after.find((i) => i.qualifiedId === 'PRD-B/issue-01')?.triage).toBe(LABELS.agentFailed);
    // Non-needs-human issues untouched.
    expect(after.find((i) => i.qualifiedId === 'PRD-B/issue-02')?.triage).toBe(LABELS.readyForAgent);
    // lastStage checkpoints survive the transition (they drive resume).
    expect(after.find((i) => i.qualifiedId === 'PRD-A/issue-02')?.lastStage).toBe('reviewFix');
  });

  it('honors a project filter', () => {
    const { issues } = setupIssues();

    const transitions = unblockNeedsHumanIssues(issues, (issue) => issue.project === 'PRD-B', {
      labels: LABELS,
      dryRun: true,
    });

    expect(transitions.map((t) => t.qualifiedId)).toEqual(['PRD-B/issue-01']);
  });

  it('dry-run returns transitions without writing any frontmatter', () => {
    const { root, issues } = setupIssues();
    const filesBefore = issues.map((issue) => readFileSync(issue.filePath, 'utf8'));

    const transitions = unblockNeedsHumanIssues(issues, null, { labels: LABELS, dryRun: true });

    expect(transitions).toHaveLength(3);
    const after = discoverIssues('issues', root);
    after.forEach((issue, index) => {
      expect(readFileSync(issue.filePath, 'utf8')).toBe(filesBefore[index]);
    });
  });

  it('returns [] when nothing is escalated', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: LABELS.readyForAgent },
    });
    const issues = discoverIssues('issues', root);
    expect(unblockNeedsHumanIssues(issues, null, { labels: LABELS })).toEqual([]);
  });
});
