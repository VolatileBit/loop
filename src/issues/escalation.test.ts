import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverIssues } from './discovery.js';
import { escalateIssueForHuman, escalateIssueForMergeConflict } from './escalation.js';
import { issueTriageRole } from './lifecycle.js';
import { cleanupTempDirs, LABELS, makeTempRoot, writeIssueFile } from './test-helpers.js';

afterEach(cleanupTempDirs);

describe('escalateIssueForHuman', () => {
  it('sets needs-human triage and appends a Loop escalation block', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: LABELS.inProgress },
      body: '## Context\n\nBody.\n',
    });
    const issue = discoverIssues('issues', root)[0]!;

    escalateIssueForHuman(issue, { summary: 'blocking spec gap' }, {
      artifactDir: `${root}/.loop/artifacts/PRD-A/issue-01/review-1`,
      maxCycles: 2,
      labels: LABELS,
      root,
    });

    expect(issueTriageRole(issue, LABELS)).toBe('readyForHuman');
    const content = readFileSync(issue.filePath, 'utf8');
    expect(content).toContain('## Loop escalation');
    expect(content).toContain('blocking spec gap');
    expect(content).toContain('loop run --unblock');
    expect(content).toContain('## Context');
  });

  it('explains recurring root-cause families instead of only reporting the cycle limit', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: LABELS.inProgress },
    });
    const issue = discoverIssues('issues', root)[0]!;

    escalateIssueForHuman(issue, { summary: 'CLI still cannot be installed directly.' }, {
      artifactDir: `${root}/.loop/runs/PRD-A/run-1/reviews`,
      maxCycles: 3,
      labels: LABELS,
      root,
      convergence: {
        reviewCount: 4,
        recurringFamilies: [
          {
            id: 'cli-packaging',
            invariant: 'Every documented install mode exposes a runnable CLI.',
            occurrences: 3,
            rounds: [1, 2, 4],
          },
        ],
        latestFamilies: [
          {
            id: 'cli-packaging',
            invariant: 'Every documented install mode exposes a runnable CLI.',
          },
        ],
        reviewsWithoutFamilies: 0,
      },
    });

    const content = readFileSync(issue.filePath, 'utf8');
    expect(content).toContain('Non-converging root-cause families');
    expect(content).toContain('`cli-packaging` (3 reviews; rounds 1, 2, 4)');
    expect(content).toContain('Every documented install mode exposes a runnable CLI.');
  });
});

describe('escalateIssueForMergeConflict', () => {
  it('sets needs-human triage, lists conflicting files, and preserves worktree path', () => {
    const root = makeTempRoot();
    writeIssueFile(root, 'issues/PRD-A/issue-01.md', {
      frontmatter: { id: 'issue-01', triage: LABELS.inProgress },
    });
    const issue = discoverIssues('issues', root)[0]!;

    escalateIssueForMergeConflict(issue, {
      branch: 'loop/issue/PRD-A/issue-01',
      worktreeDir: '/tmp/polyweave-loop-PRD-A-issue-01',
      conflictingFiles: ['shared.txt', 'src/foo.ts'],
      labels: LABELS,
    });

    expect(issueTriageRole(issue, LABELS)).toBe('readyForHuman');
    const content = readFileSync(issue.filePath, 'utf8');
    expect(content).toContain('Merging branch `loop/issue/PRD-A/issue-01`');
    expect(content).toContain('- `shared.txt`');
    expect(content).toContain('- `src/foo.ts`');
    expect(content).toContain('/tmp/polyweave-loop-PRD-A-issue-01');
    expect(content).toContain('loop run --unblock');
  });
});
