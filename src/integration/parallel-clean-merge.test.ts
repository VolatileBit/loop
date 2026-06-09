/**
 * Parallel clean merge with per-issue verify and mocked pipeline deps.
 * Exercises the same merge-back path as commands/run.ts without agent CLIs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRunResult } from '../agent/run-agent.js';
import { DEFAULT_CONFIG } from '../config/load-config.js';
import { DEFAULT_TRIAGE_LABELS } from '../config/triage-labels.js';
import type { LoopConfig } from '../config/types.js';
import {
  cleanupFixtureRepos,
  commitFile,
  createFixtureRepo,
  gitOrThrow,
  trackFixtureDir,
} from '../git/test-helpers.js';
import { discoverIssues } from '../issues/discovery.js';
import { clearIssueStage, setIssueStage } from '../issues/resolve-resume-stage.js';
import { setIssueTriage } from '../issues/lifecycle.js';
import type { IssueRecord } from '../issues/types.js';
import { runIssuePipeline } from '../pipeline/run-issue.js';
import type { PipelineDeps } from '../pipeline/deps.js';
import { shell } from '../shared/shell.js';
import type { ShellVerifyResult } from '../verify/run-verify.js';
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

function writePerIssueVerifyScript(root: string): void {
  const script = `#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
const checks = [
  ['alpha.txt', 'alpha\\n'],
  ['beta.txt', 'beta\\n'],
];
for (const [file, expected] of checks) {
  if (existsSync(file) && readFileSync(file, 'utf8') === expected) {
    process.exit(0);
  }
}
console.error('no matching per-issue artifact found');
process.exit(1);
`;
  const scriptPath = path.join(root, '.loop', 'verify.mjs');
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, script);
  gitOrThrow(['add', '.loop/verify.mjs'], root);
  gitOrThrow(['commit', '-m', 'chore: add per-issue verify'], root);
}

const PASS_VERDICT = ['## Loop verdict', 'changes-requested: no', 'severity: none', 'summary: ok'].join('\n');

function agentOk(text = 'done'): AgentRunResult {
  return {
    ok: true,
    output: text,
    usageLimited: false,
    usageLimitDetails: null,
    stuckReason: null,
    usage: null,
    costUsd: null,
    provenCommands: [],
    agentCli: 'cursor',
    model: 'auto',
  };
}

function setupParallelRepo(): { mainRoot: string; workRoot: string; issues: IssueRecord[]; config: LoopConfig } {
  const mainRoot = createFixtureRepo('loop-parallel-clean-');
  const workRoot = mainRoot;
  writeIssue(workRoot, 'PRD-A/issue-01', LABELS.readyForAgent);
  writeIssue(workRoot, 'PRD-B/issue-02', LABELS.readyForAgent);
  gitOrThrow(['add', '.'], workRoot);
  gitOrThrow(['commit', '-m', 'chore: add issues'], workRoot);
  writePerIssueVerifyScript(workRoot);

  const config: LoopConfig = {
    ...DEFAULT_CONFIG,
    verifyCmd: 'node .loop/verify.mjs',
    worktreeEnabled: false,
  };
  const issues = discoverIssues('issues', workRoot).sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId));
  return { mainRoot, workRoot, issues, config };
}

/**
 * Runs two concurrent workers over real git worktrees while the rest of the
 * suite is also running, so it is starved by CPU contention: ~7s alone, but
 * well past the suite's 60s default under load. The generous timeout buys
 * headroom without weakening a single assertion.
 */
const CONTENDED_TIMEOUT_MS = 240_000;

describe('parallel clean merge with per-issue verify (mocked pipeline)', () => {
  it('runs two workers, verifies in worktree cwd, and merges both cleanly', { timeout: CONTENDED_TIMEOUT_MS }, async () => {
    const { mainRoot, workRoot, issues, config } = setupParallelRepo();
    const verifyCwds: string[] = [];
    const claimed = new Set<string>();

    const deps: PipelineDeps = {
      runAgent: async (_prompt, opts) => {
        if (opts.stage === 'review') return agentOk(PASS_VERDICT);
        const qid = opts.stageLabel.replace(/-implement$/, '').replace(/-review-fix-\d+$/, '');
        const relFile = qid.endsWith('issue-01') ? 'alpha.txt' : 'beta.txt';
        const contents = qid.endsWith('issue-01') ? 'alpha\n' : 'beta\n';
        commitFile(opts.cwd, relFile, contents, `feat: ${qid} artifact`);
        return agentOk();
      },
      runVerifyCommand: (cmd, cwd, logPath): ShellVerifyResult => {
        verifyCwds.push(cwd);
        const result = shell(cmd, cwd);
        mkdirSync(path.dirname(logPath), { recursive: true });
        writeFileSync(logPath, result.output);
        return result;
      },
    };

    const outcomes: string[] = [];

    await runWorkerPool(
      2,
      () => {
        const next = issues.find((issue) => !claimed.has(issue.qualifiedId));
        if (!next) return null;
        claimed.add(next.qualifiedId);
        return next;
      },
      async (issue) => {
        const qid = issue.qualifiedId;
        trackFixtureDir(resolveIssueWorktreeDir(mainRoot, qid));
        const created = createIssueWorktree(mainRoot, workRoot, qid);
        if (!created.ok) throw new Error(created.error);
        const worktreeDir = created.worktree.dir;

        const worktreeIssue = discoverIssues(config.issuesDir, worktreeDir).find(
          (candidate) => candidate.qualifiedId === qid,
        );
        if (!worktreeIssue) throw new Error(`missing ${qid} in worktree`);

        const result = await runIssuePipeline(worktreeIssue, {
          entryStage: 'implement',
          iteration: 1,
          root: mainRoot,
          cwd: worktreeDir,
          config,
          labels: LABELS,
          verifyCmd: config.verifyCmd!,
          liveOutput: false,
          deps,
        });

        shell(`git checkout -- ${JSON.stringify(issue.relPath)}`, workRoot);
        const merge = mergeIssueWorktree(workRoot, 'main', qid);
        expect(merge.ok).toBe(true);
        if (!merge.ok) throw new Error('expected clean merge');

        const cleanup = cleanupIssueWorktree(mainRoot, qid);
        if (!cleanup.ok) throw new Error(cleanup.messages.join('; '));

        const rollingIssue = discoverIssues(config.issuesDir, workRoot).find(
          (candidate) => candidate.qualifiedId === qid,
        );
        if (rollingIssue) {
          setIssueTriage(rollingIssue, result.finalRole, LABELS);
          if (result.lastStage) setIssueStage(rollingIssue, result.lastStage);
          else clearIssueStage(rollingIssue);
        }

        outcomes.push(qid);
      },
    );

    expect(outcomes).toHaveLength(2);
    expect(verifyCwds).toHaveLength(2);
    expect(new Set(verifyCwds).size).toBe(2);
    for (const cwd of verifyCwds) {
      expect(cwd).not.toBe(workRoot);
      expect(path.basename(cwd)).toMatch(/-loop-PRD-[AB]-issue-0[12]$/);
    }

    expect(existsSync(path.join(workRoot, 'alpha.txt'))).toBe(true);
    expect(existsSync(path.join(workRoot, 'beta.txt'))).toBe(true);
    expect(readFileSync(path.join(workRoot, 'alpha.txt'), 'utf8')).toBe('alpha\n');
    expect(readFileSync(path.join(workRoot, 'beta.txt'), 'utf8')).toBe('beta\n');
    expect(listLeftoverIssueWorktrees(mainRoot)).toHaveLength(0);
  });
});
