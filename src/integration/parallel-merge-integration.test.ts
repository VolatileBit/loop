/**
 * Parallel worker merge-conflict escalation with real git and no agent CLIs.
 * Simulates two concurrent issue worktrees whose branches both touch the same
 * file — the first merge succeeds, the second conflicts and escalates to
 * needs-human while preserving the leftover worktree.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_TRIAGE_LABELS } from '../config/triage-labels.js';
import {
  cleanupFixtureRepos,
  commitFile,
  createFixtureRepo,
  gitOrThrow,
  trackFixtureDir,
} from '../git/test-helpers.js';
import { discoverIssues } from '../issues/discovery.js';
import { escalateIssueForMergeConflict } from '../issues/escalation.js';
import { issueTriageRole } from '../issues/lifecycle.js';
import { unblockNeedsHumanIssues } from '../issues/unblock.js';
import type { IssueRecord } from '../issues/types.js';
import {
  cleanupIssueWorktree,
  createIssueWorktree,
  listLeftoverIssueWorktrees,
  mergeIssueWorktree,
  resolveIssueWorktreeDir,
} from '../worktree/issue-worktree.js';
import { runWorkerPool } from '../worktree/worker-pool.js';

afterEach(() => {
  cleanupFixtureRepos();
});

const LABELS = DEFAULT_TRIAGE_LABELS;

function writeIssue(root: string, qualifiedId: string, triage: string): void {
  const slash = qualifiedId.indexOf('/');
  if (slash < 0) throw new Error(`invalid qualifiedId: ${qualifiedId}`);
  const project = qualifiedId.slice(0, slash);
  const id = qualifiedId.slice(slash + 1);
  const relPath = path.join('issues', project, `${id}.md`);
  const filePath = path.join(root, relPath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `---\nid: ${id}\ntitle: ${id}\ntriage: ${triage}\n---\n\n## Acceptance criteria\n\n- [ ] works\n`,
  );
}

function setupParallelRepo(): { mainRoot: string; workRoot: string; issues: IssueRecord[] } {
  const mainRoot = createFixtureRepo('loop-parallel-');
  const workRoot = mainRoot;
  commitFile(workRoot, 'shared.txt', 'base\n', 'chore: add shared baseline');

  writeIssue(workRoot, 'PRD-A/issue-01', LABELS.readyForAgent);
  writeIssue(workRoot, 'PRD-B/issue-02', LABELS.readyForAgent);
  gitOrThrow(['add', '.'], workRoot);
  gitOrThrow(['commit', '-m', 'chore: add issues'], workRoot);

  const issues = discoverIssues('issues', workRoot).sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId));
  return { mainRoot, workRoot, issues };
}

type WorkerOutcome = 'merged' | 'conflict';

function prepareIssueWorktree(
  mainRoot: string,
  workRoot: string,
  qualifiedId: string,
  fileContents: string,
): string {
  trackFixtureDir(resolveIssueWorktreeDir(mainRoot, qualifiedId));
  const created = createIssueWorktree(mainRoot, workRoot, qualifiedId);
  if (!created.ok) throw new Error(created.error);
  commitFile(created.worktree.dir, 'shared.txt', fileContents, `feat: ${qualifiedId} change`);
  return created.worktree.dir;
}

function prepareIssueWorktreeDisjoint(
  mainRoot: string,
  workRoot: string,
  qualifiedId: string,
  relFile: string,
  fileContents: string,
): string {
  trackFixtureDir(resolveIssueWorktreeDir(mainRoot, qualifiedId));
  const created = createIssueWorktree(mainRoot, workRoot, qualifiedId);
  if (!created.ok) throw new Error(created.error);
  commitFile(created.worktree.dir, relFile, fileContents, `feat: ${qualifiedId} change`);
  return created.worktree.dir;
}

function mergePreparedIssue(
  mainRoot: string,
  workRoot: string,
  qualifiedId: string,
  worktreeDir: string,
): WorkerOutcome {
  const merge = mergeIssueWorktree(workRoot, 'main', qualifiedId);
  if (merge.ok) {
    const cleanup = cleanupIssueWorktree(mainRoot, qualifiedId);
    if (!cleanup.ok) throw new Error(cleanup.messages.join('; '));
    return 'merged';
  }

  const rollingIssue = discoverIssues('issues', workRoot).find((item) => item.qualifiedId === qualifiedId);
  if (!rollingIssue) throw new Error(`issue ${qualifiedId} missing from workRoot`);

  escalateIssueForMergeConflict(rollingIssue, {
    branch: `loop/issue/${qualifiedId}`,
    worktreeDir,
    conflictingFiles: merge.conflictingFiles,
    labels: LABELS,
  });
  return 'conflict';
}

describe('parallel merge conflict escalation (real git, mocked agents)', () => {
  it('second merge after a prior issue landed escalates to needs-human and keeps the worktree', async () => {
    const { mainRoot, workRoot, issues } = setupParallelRepo();
    const prepared = new Map<string, string>();
    const claimed = new Set<string>();

    await runWorkerPool(
      2,
      () => {
        const next = issues.find((issue) => !claimed.has(issue.qualifiedId));
        if (!next) return null;
        claimed.add(next.qualifiedId);
        return next;
      },
      async (issue) => {
        const contents = issue.qualifiedId === 'PRD-A/issue-01' ? 'from issue A\n' : 'from issue B\n';
        prepared.set(issue.qualifiedId, prepareIssueWorktree(mainRoot, workRoot, issue.qualifiedId, contents));
      },
    );

    expect(prepared.size).toBe(2);

    const issueA = issues.find((item) => item.qualifiedId === 'PRD-A/issue-01')!;
    const issueB = issues.find((item) => item.qualifiedId === 'PRD-B/issue-02')!;

    expect(mergePreparedIssue(mainRoot, workRoot, issueA.qualifiedId, prepared.get(issueA.qualifiedId)!)).toBe(
      'merged',
    );
    expect(mergePreparedIssue(mainRoot, workRoot, issueB.qualifiedId, prepared.get(issueB.qualifiedId)!)).toBe(
      'conflict',
    );

    const after = discoverIssues('issues', workRoot);
    const escalated = after.filter((item) => issueTriageRole(item, LABELS) === 'readyForHuman');
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.qualifiedId).toBe('PRD-B/issue-02');
    expect(readFileSync(escalated[0]!.filePath, 'utf8')).toContain('Merging branch `loop/issue/PRD-B/issue-02`');

    const leftovers = listLeftoverIssueWorktrees(mainRoot);
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]!.qualifiedId).toBe('PRD-B/issue-02');
    expect(readFileSync(path.join(workRoot, 'shared.txt'), 'utf8')).toBe('from issue A\n');
    expect(readFileSync(path.join(leftovers[0]!.dir, 'shared.txt'), 'utf8')).toBe('from issue B\n');
  });

  it('unblock after merge-conflict escalation does not make the issue runnable until triage is reset manually', async () => {
    const { mainRoot, workRoot } = setupParallelRepo();
    const qid = 'PRD-A/issue-01';

    trackFixtureDir(resolveIssueWorktreeDir(mainRoot, qid));
    const worktree = createIssueWorktree(mainRoot, workRoot, qid);
    if (!worktree.ok) throw new Error(worktree.error);
    commitFile(worktree.worktree.dir, 'shared.txt', 'issue only\n', 'feat: solo change');
    commitFile(workRoot, 'shared.txt', 'main moved on\n', 'chore: main moved on');

    const merge = mergeIssueWorktree(workRoot, 'main', qid);
    expect(merge.ok).toBe(false);
    if (merge.ok) throw new Error('expected merge conflict');

    const issue = discoverIssues('issues', workRoot).find((item) => item.qualifiedId === qid)!;
    escalateIssueForMergeConflict(issue, {
      branch: `loop/issue/${qid}`,
      worktreeDir: worktree.worktree.dir,
      conflictingFiles: merge.conflictingFiles,
      labels: LABELS,
    });

    const transitions = unblockNeedsHumanIssues(discoverIssues('issues', workRoot), null, { labels: LABELS });
    // Merge conflicts checkpoint at implement (no lastStage) → agentFailed, runnable for retry.
    expect(transitions).toEqual([
      expect.objectContaining({
        qualifiedId: qid,
        toRole: 'agentFailed',
        resumeStage: 'implement',
      }),
    ]);
    expect(issueTriageRole(discoverIssues('issues', workRoot).find((i) => i.qualifiedId === qid)!, LABELS)).toBe(
      'agentFailed',
    );
    expect(listLeftoverIssueWorktrees(mainRoot)).toHaveLength(1);
  });

  it('disjoint file changes from two parallel issues both merge cleanly', async () => {
    const { mainRoot, workRoot, issues } = setupParallelRepo();
    const prepared = new Map<string, string>();
    const claimed = new Set<string>();

    await runWorkerPool(
      2,
      () => {
        const next = issues.find((issue) => !claimed.has(issue.qualifiedId));
        if (!next) return null;
        claimed.add(next.qualifiedId);
        return next;
      },
      async (issue) => {
        const relFile = issue.qualifiedId === 'PRD-A/issue-01' ? 'alpha.txt' : 'beta.txt';
        const contents = issue.qualifiedId === 'PRD-A/issue-01' ? 'alpha\n' : 'beta\n';
        prepared.set(
          issue.qualifiedId,
          prepareIssueWorktreeDisjoint(mainRoot, workRoot, issue.qualifiedId, relFile, contents),
        );
      },
    );

    expect(prepared.size).toBe(2);

    for (const issue of issues) {
      expect(mergePreparedIssue(mainRoot, workRoot, issue.qualifiedId, prepared.get(issue.qualifiedId)!)).toBe(
        'merged',
      );
    }

    expect(existsSync(path.join(workRoot, 'alpha.txt'))).toBe(true);
    expect(existsSync(path.join(workRoot, 'beta.txt'))).toBe(true);
    expect(readFileSync(path.join(workRoot, 'alpha.txt'), 'utf8')).toBe('alpha\n');
    expect(readFileSync(path.join(workRoot, 'beta.txt'), 'utf8')).toBe('beta\n');
    expect(listLeftoverIssueWorktrees(mainRoot)).toHaveLength(0);
  });
});
