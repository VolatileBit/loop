/**
 * End-to-end resume/unblock chain without real agent CLIs: needs-human
 * escalation → `loop run --unblock` transitions → scheduling picks the issue
 * → resolveResumeStage → mocked pipeline resumes at the correct stage.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRunResult } from '../agent/run-agent.js';
import { DEFAULT_CONFIG } from '../config/load-config.js';
import { DEFAULT_TRIAGE_LABELS } from '../config/triage-labels.js';
import type { LoopConfig, StageName } from '../config/types.js';
import { cleanupFixtureRepos, createFixtureRepo, gitOrThrow } from '../git/test-helpers.js';
import { readPendingReviewFeedback, writePendingReviewFeedback } from '../handoff/handoff.js';
import { discoverIssues } from '../issues/discovery.js';
import type { IssueRecord } from '../issues/types.js';
import { pickNextIssue } from '../issues/scheduling.js';
import { resolveResumeStage } from '../issues/resolve-resume-stage.js';
import { unblockNeedsHumanIssues } from '../issues/unblock.js';
import type { PipelineDeps } from '../pipeline/deps.js';
import { runIssuePipeline, type IssuePipelineOptions } from '../pipeline/run-issue.js';
import type { ShellVerifyResult } from '../verify/run-verify.js';

afterEach(() => {
  cleanupFixtureRepos();
});

const LABELS = DEFAULT_TRIAGE_LABELS;

const PASS_VERDICT = ['## Loop verdict', 'changes-requested: no', 'severity: none', 'summary: ok'].join('\n');

function agentOk(text: string): AgentRunResult {
  return {
    ok: true,
    output: JSON.stringify({ type: 'result', is_error: false, result: text }),
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

type ScriptedDeps = {
  deps: PipelineDeps;
  stages: StageName[];
};

function scriptedDeps(options: {
  reviewVerdicts?: string[];
  verifyResults?: boolean[];
}): ScriptedDeps {
  const stages: StageName[] = [];
  const reviewVerdicts = [...(options.reviewVerdicts ?? [PASS_VERDICT])];
  const verifyResults = [...(options.verifyResults ?? [])];

  const deps: PipelineDeps = {
    runAgent: async (_prompt, opts) => {
      stages.push(opts.stage);
      if (opts.stage === 'review') return agentOk(reviewVerdicts.shift() ?? PASS_VERDICT);
      return agentOk('done');
    },
    runVerifyCommand: (): ShellVerifyResult => {
      const ok = verifyResults.length > 0 ? verifyResults.shift()! : true;
      return { ok, output: ok ? 'all green' : ' FAIL  packages/foo/a.test.ts > case', code: ok ? 0 : 1 };
    },
  };

  return { deps, stages };
}

function writeIssue(
  root: string,
  frontmatter: Record<string, string>,
  body = '\n## Acceptance criteria\n\n- [x] works\n',
): string {
  const relPath = path.join('issues', 'PRD-001', 'issue-01.md');
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
  const filePath = path.join(root, relPath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `---\n${lines.join('\n')}\n---\n${body}`);
  gitOrThrow(['config', 'commit.gpgsign', 'false'], root);
  gitOrThrow(['add', '.'], root);
  gitOrThrow(['commit', '-m', 'chore: add issue'], root);
  return relPath;
}

function setupEscalatedRepo(frontmatter: Record<string, string>): {
  root: string;
  issue: IssueRecord;
  config: LoopConfig;
} {
  const root = createFixtureRepo('loop-resume-');
  writeIssue(root, frontmatter);
  const config: LoopConfig = { ...DEFAULT_CONFIG, verifyCmd: 'fake-verify' };
  const issue = discoverIssues(config.issuesDir, root).find((item) => item.qualifiedId === 'PRD-001/issue-01')!;
  return { root, issue, config };
}

function pipelineOptions(
  root: string,
  config: LoopConfig,
  entry: StageName,
  deps: PipelineDeps,
): IssuePipelineOptions {
  return {
    entryStage: entry,
    iteration: 1,
    root,
    cwd: root,
    config,
    labels: LABELS,
    verifyCmd: 'fake-verify',
    liveOutput: false,
    deps,
  };
}

describe('resume/unblock integration (mocked pipeline)', () => {
  it('ready-for-agent with a retained reviewFix checkpoint resumes instead of reimplementing', async () => {
    const { root, issue, config } = setupEscalatedRepo({
      id: 'issue-01',
      title: 'Test issue',
      triage: LABELS.readyForAgent,
      lastStage: 'reviewFix',
    });
    writePendingReviewFeedback(root, issue, 'Classify the remaining visual fixtures.');

    const next = pickNextIssue(discoverIssues(config.issuesDir, root), LABELS)!;
    const entry = resolveResumeStage(next, LABELS);
    expect(entry).toBe('reviewFix');

    const { deps, stages } = scriptedDeps({ verifyResults: [true] });
    const result = await runIssuePipeline(next, pipelineOptions(root, config, entry, deps));

    expect(result.outcome).toBe('completed');
    expect(stages).toEqual(['reviewFix', 'review']);
  });

  it('needs-human verifyFix → --unblock → verifyFailed → resumes at verifyFix and completes', async () => {
    const { root, issue, config } = setupEscalatedRepo({
      id: 'issue-01',
      title: 'Test issue',
      triage: LABELS.readyForHuman,
      lastStage: 'verifyFix',
    });

    const transitions = unblockNeedsHumanIssues(discoverIssues(config.issuesDir, root), null, { labels: LABELS });
    expect(transitions).toEqual([
      expect.objectContaining({
        qualifiedId: 'PRD-001/issue-01',
        toRole: 'verifyFailed',
        resumeStage: 'verifyFix',
      }),
    ]);

    const rediscovered = discoverIssues(config.issuesDir, root);
    const next = pickNextIssue(rediscovered, LABELS);
    expect(next?.qualifiedId).toBe('PRD-001/issue-01');
    expect(next?.triage).toBe(LABELS.verifyFailed);

    const entry = resolveResumeStage(next!, LABELS);
    expect(entry).toBe('verifyFix');

    const { deps, stages } = scriptedDeps({ verifyResults: [false, true] });
    const result = await runIssuePipeline(next!, pipelineOptions(root, config, entry, deps));

    expect(result.outcome).toBe('completed');
    expect(stages).toEqual(['verifyFix', 'review']);
    expect(readFileSync(issue.filePath, 'utf8')).toContain(`triage: ${LABELS.done}`);
  });

  it('needs-human reviewFix → --unblock → agentFailed → resumes at reviewFix using pending feedback', async () => {
    const { root, issue, config } = setupEscalatedRepo({
      id: 'issue-01',
      title: 'Test issue',
      triage: LABELS.readyForHuman,
      lastStage: 'reviewFix',
    });
    writePendingReviewFeedback(root, issue, 'Fix the null check in transitions.ts.');

    const transitions = unblockNeedsHumanIssues(discoverIssues(config.issuesDir, root), null, { labels: LABELS });
    expect(transitions[0]).toEqual(
      expect.objectContaining({ toRole: 'agentFailed', resumeStage: 'reviewFix' }),
    );

    const next = pickNextIssue(discoverIssues(config.issuesDir, root), LABELS)!;
    const entry = resolveResumeStage(next, LABELS);
    expect(entry).toBe('reviewFix');

    const prompts: string[] = [];
    const { deps, stages } = scriptedDeps({ verifyResults: [true] });
    const baseRunAgent = deps.runAgent;
    deps.runAgent = async (prompt, opts) => {
      prompts.push(prompt);
      return baseRunAgent(prompt, opts);
    };

    const result = await runIssuePipeline(next, pipelineOptions(root, config, entry, deps));

    expect(result.outcome).toBe('completed');
    expect(stages).toEqual(['reviewFix', 'review']);
    expect(prompts[0]).toContain('Fix the null check in transitions.ts.');
    expect(readPendingReviewFeedback(root, issue)).toBeNull();
  });

  it('dry-run --unblock leaves frontmatter unchanged then a real unblock enables scheduling', async () => {
    const { root, config } = setupEscalatedRepo({
      id: 'issue-01',
      title: 'Test issue',
      triage: LABELS.readyForHuman,
      lastStage: 'implement',
    });
    const before = readFileSync(path.join(root, 'issues/PRD-001/issue-01.md'), 'utf8');

    const issues = discoverIssues(config.issuesDir, root);
    const dry = unblockNeedsHumanIssues(issues, null, { labels: LABELS, dryRun: true });
    expect(dry).toHaveLength(1);
    expect(readFileSync(path.join(root, 'issues/PRD-001/issue-01.md'), 'utf8')).toBe(before);
    expect(pickNextIssue(issues, LABELS)).toBeNull();

    unblockNeedsHumanIssues(discoverIssues(config.issuesDir, root), null, { labels: LABELS });
    const next = pickNextIssue(discoverIssues(config.issuesDir, root), LABELS);
    expect(next?.triage).toBe(LABELS.agentFailed);
    expect(resolveResumeStage(next!, LABELS)).toBe('implement');
  });
});
