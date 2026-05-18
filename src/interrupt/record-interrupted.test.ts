import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_TRIAGE_LABELS } from '../config/triage-labels.js';
import { cleanupFixtureRepos, createFixtureRepo, gitOrThrow } from '../git/test-helpers.js';
import { discoverIssues } from '../issues/discovery.js';
import { issueTriageRole } from '../issues/lifecycle.js';
import { recordInterruptedRun } from '../logs/run-record.js';
import type { RunContext } from '../logs/run-context.js';

afterEach(() => {
  cleanupFixtureRepos();
});

const LABELS = DEFAULT_TRIAGE_LABELS;

describe('recordInterruptedRun', () => {
  it('marks the issue agent-interrupted and writes an interrupted run record', () => {
    const root = createFixtureRepo('loop-interrupted-');
    const relPath = path.join('issues', 'PRD-001', 'issue-01.md');
    const filePath = path.join(root, relPath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const content = `---
id: issue-01
title: Interrupt test
triage: ${LABELS.inProgress}
lastStage: implement
---
## Acceptance criteria

- [ ] works
`;
    writeFileSync(filePath, content);
    gitOrThrow(['add', '.'], root);
    gitOrThrow(['commit', '-m', 'chore: add issue'], root);

    const issue = discoverIssues('issues', root).find((item) => item.qualifiedId === 'PRD-001/issue-01')!;
    const runDir = path.join(root, '.loop', 'runs', 'test-run');
    mkdirSync(runDir, { recursive: true });

    const ctx: RunContext = {
      runId: 'test-run',
      startedAt: new Date().toISOString(),
      iteration: 1,
      issue,
      workRoot: root,
      runDir,
      agentLogPath: path.join(runDir, 'agent.stream.log'),
      verifyLogPath: path.join(runDir, 'verify.log'),
      promptPath: path.join(runDir, 'prompt.md'),
      summaryPath: path.join(runDir, 'summary.json'),
      issueStartSha: null,
      usageEntries: [],
      commits: [],
    };

    recordInterruptedRun(ctx, root, LABELS);

    const updated = discoverIssues('issues', root).find((item) => item.qualifiedId === 'PRD-001/issue-01')!;
    expect(issueTriageRole(updated, LABELS)).toBe('agentInterrupted');

    const summary = JSON.parse(readFileSync(ctx.summaryPath, 'utf8')) as { outcome: string; stuckReason: string };
    expect(summary.outcome).toBe('interrupted');
    expect(summary.stuckReason).toBe('interrupted');
  });
});
