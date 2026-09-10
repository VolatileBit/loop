/**
 * Resume-entry tests for the per-issue pipeline, using the injectable
 * runAgent/runVerifyCommand seams (pipeline/deps.ts) so no real agent CLI or
 * verify command runs. Git operations run against a throwaway fixture repo
 * (loop's commits are part of observable pipeline behavior).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRunResult } from '../agent/run-agent.js';
import { DEFAULT_CONFIG } from '../config/load-config.js';
import { DEFAULT_TRIAGE_LABELS } from '../config/triage-labels.js';
import type { LoopConfig, StageName } from '../config/types.js';
import { cleanupFixtureRepos, createFixtureRepo, gitOrThrow } from '../git/test-helpers.js';
import { readPendingReviewFeedback, writePendingReviewFeedback } from '../handoff/handoff.js';
import { discoverIssues } from '../issues/discovery.js';
import type { IssueRecord } from '../issues/types.js';
import { writeDeclaredVerifyCmd } from '../verify/declared-verify.js';
import type { ShellVerifyResult } from '../verify/run-verify.js';
import type { PipelineDeps } from './deps.js';
import { runIssuePipeline, type IssuePipelineOptions } from './run-issue.js';

afterEach(() => {
  cleanupFixtureRepos();
});

const LABELS = DEFAULT_TRIAGE_LABELS;

const PASS_VERDICT = ['## Loop verdict', 'changes-requested: no', 'severity: none', 'summary: ok'].join('\n');
const BLOCKING_VERDICT = [
  '## Spec',
  'Missing the wrong-role event.',
  '',
  '## Loop verdict',
  'changes-requested: yes',
  'severity: blocking',
  'summary: blocking issue found',
  '',
  '## Loop finding families',
  '- `role-rejection-audit`: Every rejected role transition records the same audit event.',
].join('\n');
const UNSTRUCTURED_BLOCKING_VERDICT = [
  '## Spec',
  'Missing the wrong-role event.',
  '',
  '## Loop verdict',
  'changes-requested: yes',
  'severity: blocking',
  'summary: blocking issue found',
].join('\n');
const RECURRING_BLOCKING_VERDICT = [
  '## Spec',
  'The documented direct install still omits the executable.',
  '',
  '## Loop verdict',
  'changes-requested: yes',
  'severity: blocking',
  'summary: CLI package remains incomplete',
  '',
  '## Loop finding families',
  '- `cli-packaging`: Every documented install mode exposes a runnable CLI.',
].join('\n');

function agentOk(text: string, provenCommands: string[] = []): AgentRunResult {
  return {
    ok: true,
    output: JSON.stringify({ type: 'result', is_error: false, result: text }),
    usageLimited: false,
    usageLimitDetails: null,
    stuckReason: null,
    usage: null,
    costUsd: null,
    provenCommands,
    agentCli: 'cursor',
    model: 'auto',
  };
}

type AgentCall = {
  stage: StageName;
  label: string;
  prompt: string;
  resumedSessionId: string | null;
};

/**
 * Scripted agent: responds per stage — review stages return the queued
 * verdict texts in order; implement/fix stages return a plain ok result
 * (optionally carrying in-session verify evidence).
 */
function fakeDeps(options: {
  reviewVerdicts?: string[];
  verifyResults?: boolean[];
  reviewFixText?: string;
  /** In-session verify evidence per work session, by stage (or every stage when an array). */
  provenCommands?: string[] | ((stage: StageName) => string[]);
}): { deps: PipelineDeps; agentCalls: AgentCall[]; verifyCount: () => number } {
  const agentCalls: AgentCall[] = [];
  const reviewVerdicts = [...(options.reviewVerdicts ?? [PASS_VERDICT])];
  const verifyResults = [...(options.verifyResults ?? [])];
  let verifyCalls = 0;
  const provenFor = (stage: StageName): string[] =>
    typeof options.provenCommands === 'function'
      ? options.provenCommands(stage)
      : (options.provenCommands ?? []);

  const deps: PipelineDeps = {
    runAgent: async (prompt, opts) => {
      agentCalls.push({
        stage: opts.stage,
        label: opts.stageLabel,
        prompt,
        resumedSessionId: (opts as { resume?: { sessionId: string } | null }).resume?.sessionId ?? null,
      });
      if (opts.stage === 'review') {
        return agentOk(reviewVerdicts.shift() ?? PASS_VERDICT);
      }
      if (opts.stage === 'reviewFix') {
        return agentOk(
          options.reviewFixText ??
            [
              '## Loop fix coverage',
              '- `role-rejection-audit` — invariant: covered; central fix: shared seam; sibling cases audited: matrix; tests: focused regression.',
              '- `cli-packaging` — invariant: covered; central fix: shared seam; sibling cases audited: matrix; tests: focused regression.',
            ].join('\n'),
          provenFor(opts.stage),
        );
      }
      return agentOk('done', provenFor(opts.stage));
    },
    runVerifyCommand: (): ShellVerifyResult => {
      verifyCalls += 1;
      const ok = verifyResults.length > 0 ? verifyResults.shift()! : true;
      return { ok, output: ok ? 'all green' : ' FAIL  packages/foo/a.test.ts > case', code: ok ? 0 : 1 };
    },
  };

  return { deps, agentCalls, verifyCount: () => verifyCalls };
}

function setupRepo(frontmatter: Record<string, string> = {}): { root: string; issue: IssueRecord; config: LoopConfig } {
  const root = createFixtureRepo('loop-pipeline-');
  const lines = Object.entries({
    id: 'issue-01',
    title: 'Test issue',
    triage: LABELS.readyForAgent,
    ...frontmatter,
  }).map(([key, value]) => `${key}: ${value}`);
  const body = ['', '## Acceptance criteria', '', '- [x] works', ''].join('\n');
  const relPath = path.join('issues', 'PRD-001', 'issue-01.md');
  gitOrThrow(['config', 'commit.gpgsign', 'false'], root);
  const content = `---\n${lines.join('\n')}\n---\n${body}`;
  const filePath = path.join(root, relPath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  gitOrThrow(['add', '.'], root);
  gitOrThrow(['commit', '-m', 'chore: add issue'], root);

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

function issueFileContent(issue: IssueRecord): string {
  return readFileSync(issue.filePath, 'utf8');
}

describe('runIssuePipeline entry points', () => {
  it('implement entry runs implement → verify → review and completes', async () => {
    const { root, issue, config } = setupRepo();
    const { deps, agentCalls, verifyCount } = fakeDeps({ reviewVerdicts: [PASS_VERDICT] });

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));

    expect(result.outcome).toBe('completed');
    expect(result.issueDone).toBe(true);
    expect(result.finalRole).toBe('done');
    expect(result.fatal).toBeNull();
    expect(agentCalls.map((call) => call.stage)).toEqual(['implement', 'review']);
    expect(verifyCount()).toBe(1);

    const content = issueFileContent(issue);
    expect(content).toContain(`triage: ${LABELS.done}`);
    expect(content).not.toContain('lastStage:');
  });

  it('sends unfinished work back to implement instead of re-verifying it forever', async () => {
    const { root, issue, config } = setupRepo();
    // Verify will pass, but a criterion is outstanding: the remaining work is
    // unwritten, not a failing test.
    writeFileSync(
      path.join(root, issue.relPath),
      `---\nid: issue-01\ntitle: Test issue\ntriage: ${LABELS.readyForAgent}\n---\n\n` +
        '## Acceptance criteria\n\n- [x] works\n- [ ] renderer tests cover deep links\n',
    );
    const { deps } = fakeDeps({ reviewVerdicts: [PASS_VERDICT] });

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));

    expect(result.outcome).toBe('issue-not-marked-done');
    // Without this the next run resumes at verifyFix, re-runs a green gate and
    // stops here again — a livelock no restart can clear.
    expect(result.lastStage).toBe('implement');
    expect(issueFileContent(issue)).toContain('lastStage: implement');
    // The outstanding criterion is named, so a compacted session need not
    // re-derive it.
    expect(result.fatal?.details).toContain('Unchecked: renderer tests cover deep links');
  });

  it('commits work left dirty by an earlier run when resuming, rather than preserving it forever', async () => {
    const { root, issue, config } = setupRepo();
    // Stand in for lab changes a previous run produced but could not commit:
    // its sandbox denies `git index.lock`.
    const stranded = path.join(root, 'packages', 'design-system', 'lab', 'component-lab.spec.ts');
    mkdirSync(path.dirname(stranded), { recursive: true });
    writeFileSync(stranded, "export const registry = { Table: '.pw-table' };\n");
    const { deps } = fakeDeps({ reviewVerdicts: [PASS_VERDICT] });

    await runIssuePipeline(issue, pipelineOptions(root, config, 'review', deps));

    // Treating it as pre-existing would keep it out of every fallback commit,
    // so review would judge a HEAD that never contains it.
    const tracked = gitOrThrow(['ls-files', 'packages/design-system/lab/component-lab.spec.ts'], root);
    expect(tracked).not.toBe('');
  });

  it('skips the initial verify when the implement session proved the exact command in-stream', async () => {
    const { root, issue, config } = setupRepo();
    const { deps, agentCalls, verifyCount } = fakeDeps({
      reviewVerdicts: [PASS_VERDICT],
      provenCommands: ['fake-verify'],
    });

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));

    expect(result.outcome).toBe('completed');
    expect(agentCalls.map((call) => call.stage)).toEqual(['implement', 'review']);
    // The duplicate initial verify run is skipped; its log artifact says so.
    expect(verifyCount()).toBe(0);
    const runDir = result.runDir;
    expect(readFileSync(path.join(runDir, 'verify.log'), 'utf8')).toContain('SKIPPED');
  });

  it('resume entries never consult evidence — the fresh verify still runs', async () => {
    const { root, issue, config } = setupRepo({
      triage: LABELS.verifyFailed,
      lastStage: 'verifyFix',
    });
    const { deps, verifyCount } = fakeDeps({
      reviewVerdicts: [PASS_VERDICT],
      verifyResults: [true],
      provenCommands: ['fake-verify'],
    });

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'verifyFix', deps));

    expect(result.outcome).toBe('completed');
    expect(verifyCount()).toBe(1);
  });

  it('skips the per-cycle re-verify when the fix session proved the command', async () => {
    const { root, issue, config } = setupRepo();
    // Initial verify fails; the fix session proves the gate in-stream, so no
    // second mechanical verify runs. (Only fix sessions carry evidence here —
    // the implement session must not, or the initial verify would be skipped.)
    const { deps, agentCalls, verifyCount } = fakeDeps({
      reviewVerdicts: [PASS_VERDICT],
      verifyResults: [false],
      provenCommands: (stage) => (stage === 'verifyFix' ? ['fake-verify'] : []),
    });

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));

    expect(result.outcome).toBe('completed');
    expect(agentCalls.map((call) => call.stage)).toEqual(['implement', 'verifyFix', 'review']);
    expect(verifyCount()).toBe(1);
  });

  it('verifyFix entry skips implement, re-verifies fresh, and fixes until green', async () => {
    const { root, issue, config } = setupRepo({
      triage: LABELS.verifyFailed,
      lastStage: 'verifyFix',
    });
    // First verify fails (fresh re-derivation), fix pass, then verify passes.
    const { deps, agentCalls } = fakeDeps({
      reviewVerdicts: [PASS_VERDICT],
      verifyResults: [false, true],
    });

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'verifyFix', deps));

    expect(result.outcome).toBe('completed');
    expect(agentCalls.map((call) => call.stage)).toEqual(['verifyFix', 'review']);
  });

  it('review entry runs the safety verify once and goes straight to review when it passes', async () => {
    const { root, issue, config } = setupRepo({
      triage: LABELS.agentFailed,
      lastStage: 'review',
    });
    const { deps, agentCalls, verifyCount } = fakeDeps({
      reviewVerdicts: [PASS_VERDICT],
      verifyResults: [true],
    });

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'review', deps));

    expect(result.outcome).toBe('completed');
    expect(agentCalls.map((call) => call.stage)).toEqual(['review']);
    expect(verifyCount()).toBe(1);
  });

  it('review entry falls back to verifyFix when the safety verify fails (stale checkpoint)', async () => {
    const { root, issue, config } = setupRepo({
      triage: LABELS.agentFailed,
      lastStage: 'review',
    });
    // Safety verify fails → verifyFix entry: fix pass, then verify passes.
    const { deps, agentCalls } = fakeDeps({
      reviewVerdicts: [PASS_VERDICT],
      verifyResults: [false, true],
    });

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'review', deps));

    expect(result.outcome).toBe('completed');
    expect(agentCalls.map((call) => call.stage)).toEqual(['verifyFix', 'review']);
  });

  it('reviewFix entry skips the leading review and builds the fix prompt from pending feedback', async () => {
    const { root, issue, config } = setupRepo({
      triage: LABELS.agentFailed,
      lastStage: 'reviewFix',
    });
    writePendingReviewFeedback(root, issue, 'Fix the null check in transitions.ts.');

    const prompts: string[] = [];
    const { deps, agentCalls } = fakeDeps({
      reviewVerdicts: [PASS_VERDICT],
      verifyResults: [true],
    });
    const baseRunAgent = deps.runAgent;
    deps.runAgent = async (prompt, opts) => {
      prompts.push(prompt);
      return baseRunAgent(prompt, opts);
    };

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'reviewFix', deps));

    expect(result.outcome).toBe('completed');
    // First agent call is the fix pass, not a review.
    expect(agentCalls.map((call) => call.stage)).toEqual(['reviewFix', 'review']);
    expect(prompts[0]).toContain('Fix the null check in transitions.ts.');
    // Pending feedback is cleared once the round resolves.
    expect(readPendingReviewFeedback(root, issue)).toBeNull();
  });

  it('reviewFix entry without pending feedback degrades to the review entry (safety verify + fresh review)', async () => {
    const { root, issue, config } = setupRepo({
      triage: LABELS.agentFailed,
      lastStage: 'reviewFix',
    });
    const { deps, agentCalls, verifyCount } = fakeDeps({
      reviewVerdicts: [PASS_VERDICT],
      verifyResults: [true],
    });

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'reviewFix', deps));

    expect(result.outcome).toBe('completed');
    expect(agentCalls.map((call) => call.stage)).toEqual(['review']);
    expect(verifyCount()).toBe(1);
  });
});

describe('runIssuePipeline goal mode', () => {
  it('gates with the declared command and re-reads it before every verify', async () => {
    const { root, issue, config } = setupRepo();
    const verifyCmds: string[] = [];
    let declared: string | null = null;

    const deps: PipelineDeps = {
      runAgent: async (_prompt, opts) => {
        if (opts.stage === 'implement') declared = 'pnpm goal-test';
        return agentOk(opts.stage === 'review' ? PASS_VERDICT : 'done');
      },
      runVerifyCommand: (cmd): ShellVerifyResult => {
        verifyCmds.push(cmd);
        return { ok: true, output: 'green', code: 0 };
      },
    };

    const result = await runIssuePipeline(issue, {
      ...pipelineOptions(root, config, 'implement', deps),
      verifyCmd: '',
      goal: {
        goalDocPath: '/g/goal.md',
        declareVerifyPath: '/g/verify/issue-01.cmd',
        verifyNotesPath: '/g/VERIFY.md',
        readDeclaredVerifyCmd: () => declared,
      },
    });

    expect(result.outcome).toBe('completed');
    expect(verifyCmds).toEqual(['pnpm goal-test']);
  });

  it('escalates as unverifiable when the session declares nothing', async () => {
    const { root, issue, config } = setupRepo();
    const { deps } = fakeDeps({ reviewVerdicts: [PASS_VERDICT] });

    const result = await runIssuePipeline(issue, {
      ...pipelineOptions(root, config, 'implement', deps),
      verifyCmd: '',
      goal: {
        goalDocPath: '/g/goal.md',
        declareVerifyPath: '/g/verify/issue-01.cmd',
        verifyNotesPath: '/g/VERIFY.md',
        readDeclaredVerifyCmd: () => null,
      },
    });

    expect(result.outcome).toBe('unverifiable');
    expect(result.finalRole).toBe('readyForHuman');
    expect(result.fatal).not.toBeNull();
    const content = issueFileContent(issue);
    expect(content).toContain(`triage: ${LABELS.readyForHuman}`);
    expect(content).toContain('no verify command');
    expect(content).toContain('lastStage: verifyFix');
  });
});

describe('runIssuePipeline failure checkpoints', () => {
  it('tags verify-failed with a verifyFix checkpoint after exhausting fix cycles', async () => {
    const { root, issue, config } = setupRepo();
    const failing = { ...config, maxVerifyCycles: 2 };
    // Initial verify + 2 fix cycles all fail.
    const { deps, agentCalls } = fakeDeps({ verifyResults: [false, false, false] });

    const result = await runIssuePipeline(issue, pipelineOptions(root, failing, 'implement', deps));

    expect(result.outcome).toBe('verify-failed');
    expect(result.finalRole).toBe('verifyFailed');
    expect(result.lastStage).toBe('verifyFix');
    expect(result.fatal).not.toBeNull();
    expect(agentCalls.map((call) => call.stage)).toEqual(['implement', 'verifyFix', 'verifyFix']);

    const content = issueFileContent(issue);
    expect(content).toContain(`triage: ${LABELS.verifyFailed}`);
    expect(content).toContain('lastStage: verifyFix');
  });

  it('records pending review feedback and a reviewFix checkpoint when review cycles are exhausted', async () => {
    const { root, issue, config } = setupRepo();
    const oneCycle = { ...config, maxReviewCycles: 1 };
    // Review 1: blocking → fix pass → review 2: still blocking → needs-human.
    const { deps, agentCalls } = fakeDeps({
      reviewVerdicts: [BLOCKING_VERDICT, BLOCKING_VERDICT],
      verifyResults: [true, true],
    });

    const result = await runIssuePipeline(issue, pipelineOptions(root, oneCycle, 'implement', deps));

    expect(result.outcome).toBe('needs-human');
    expect(result.finalRole).toBe('readyForHuman');
    expect(agentCalls.map((call) => call.stage)).toEqual(['implement', 'review', 'reviewFix', 'review']);

    const content = issueFileContent(issue);
    expect(content).toContain(`triage: ${LABELS.readyForHuman}`);
    // needs-human checkpoints at reviewFix so --unblock resumes at the fix pass.
    expect(content).toContain('lastStage: reviewFix');
    expect(content).toContain('## Loop escalation');
    // The blocking verdict is persisted for a later resume/unblock.
    expect(readPendingReviewFeedback(root, issue)).toContain('Missing the wrong-role event.');
  });

  it('carries review history forward and deepens the second fix for a recurring family', async () => {
    const { root, issue, config } = setupRepo();
    const twoCycles = { ...config, maxReviewCycles: 2 };
    const { deps, agentCalls } = fakeDeps({
      reviewVerdicts: [
        RECURRING_BLOCKING_VERDICT,
        RECURRING_BLOCKING_VERDICT,
        RECURRING_BLOCKING_VERDICT,
      ],
      verifyResults: [true, true, true],
    });

    const result = await runIssuePipeline(issue, pipelineOptions(root, twoCycles, 'implement', deps));

    expect(result.outcome).toBe('needs-human');
    const fixPrompts = agentCalls.filter((call) => call.stage === 'reviewFix').map((call) => call.prompt);
    expect(fixPrompts).toHaveLength(2);
    expect(fixPrompts[0]).not.toContain('Deep-fix mode');
    expect(fixPrompts[1]).toContain('Deep-fix mode');
    expect(fixPrompts[1]).toContain('`cli-packaging` has recurred across 2 reviews');

    const reviewPrompts = agentCalls.filter((call) => call.stage === 'review').map((call) => call.prompt);
    expect(reviewPrompts[1]).toContain('Prior review/fix history');
    expect(reviewPrompts[1]).toContain('central fix: shared seam');

    const content = issueFileContent(issue);
    expect(content).toContain('`cli-packaging` (3 reviews)');
    expect(result.fatal?.details).toContainEqual(expect.stringContaining('cli-packaging'));
  });

  it('stops at reviewFix without spending another review when required coverage is missing', async () => {
    const { root, issue, config } = setupRepo();
    const { deps, agentCalls } = fakeDeps({
      reviewVerdicts: [RECURRING_BLOCKING_VERDICT],
      reviewFixText: 'Implemented a narrow fix but omitted the coverage block.',
      verifyResults: [true],
    });

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));

    expect(result.outcome).toBe('fix-coverage-missing');
    expect(result.lastStage).toBe('reviewFix');
    expect(agentCalls.map((call) => call.stage)).toEqual(['implement', 'review', 'reviewFix']);
    expect(result.fatal?.details).toContainEqual(expect.stringContaining('cli-packaging'));
  });

  it('rejects a fresh blocking review that omits structured finding families', async () => {
    const { root, issue, config } = setupRepo();
    const { deps, agentCalls } = fakeDeps({
      reviewVerdicts: [UNSTRUCTURED_BLOCKING_VERDICT],
      verifyResults: [true],
    });

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));

    expect(result.outcome).toBe('review-failed');
    expect(result.lastStage).toBe('review');
    expect(agentCalls.map((call) => call.stage)).toEqual(['implement', 'review']);
    const reviewArtifact = JSON.parse(
      readFileSync(
        path.join(result.runDir, 'reviews', 'round-1', 'review.json'),
        'utf8',
      ),
    ) as { completed: boolean; contractError: string | null };
    expect(reviewArtifact).toMatchObject({
      completed: false,
      contractError: expect.stringContaining('structured finding family'),
    });
  });

  it('stops with usage-limit outcome and exit code 2 when implement hits quota', async () => {
    const { root, issue, config } = setupRepo();
    const deps: PipelineDeps = {
      runAgent: async () => ({
        ok: false,
        output: "You've hit your usage limit",
        usageLimited: true,
        usageLimitDetails: { scope: 'session', resetsAtMs: null },
        stuckReason: null,
        usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.1,
        provenCommands: [],
        agentCli: 'claude-code',
        model: 'opus-5',
        attempts: [
          {
            agentCli: 'codex',
            model: 'gpt-5.6-sol',
            usage: { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: null,
          },
          {
            agentCli: 'claude-code',
            model: 'opus-5',
            usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: 0.1,
          },
        ],
      }),
      runVerifyCommand: () => ({ ok: true, output: '', code: 0 }),
    };

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));

    expect(result.outcome).toBe('usage-limit');
    expect(result.fatal).toEqual(expect.objectContaining({ code: 2 }));
    expect(result.usageLimited).toBe(true);
    expect(result.usageEntries).toEqual([
      expect.objectContaining({ agentCli: 'codex', inputTokens: 2 }),
      expect.objectContaining({ agentCli: 'claude-code', inputTokens: 5, costUsd: 0.1 }),
    ]);
    const summary = JSON.parse(
      readFileSync(path.join(result.runDir, 'summary.json'), 'utf8'),
    ) as { model: string };
    expect(summary.model).toBe('opus-5');

    const content = issueFileContent(issue);
    expect(content).toContain(`triage: ${LABELS.agentFailed}`);
    expect(content).toContain('lastStage: implement');
  });

  it('marks agent-failed with an implement checkpoint when the implement session fails', async () => {
    const { root, issue, config } = setupRepo();
    const deps: PipelineDeps = {
      runAgent: async () => ({
        ok: false,
        output: 'boom',
        usageLimited: false,
        usageLimitDetails: null,
        stuckReason: null,
        usage: null,
        costUsd: null,
        provenCommands: [],
        agentCli: 'cursor',
        model: 'auto',
      }),
      runVerifyCommand: () => ({ ok: true, output: '', code: 0 }),
    };

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));

    expect(result.outcome).toBe('agent-failed');
    expect(result.finalRole).toBe('agentFailed');
    expect(result.lastStage).toBe('implement');
    expect(result.fatal).not.toBeNull();

    const content = issueFileContent(issue);
    expect(content).toContain(`triage: ${LABELS.agentFailed}`);
    expect(content).toContain('lastStage: implement');
  });
});

describe('runIssuePipeline session resume', () => {
  it('resumes the dead session only at the matching entry stage', async () => {
    const { root, issue, config } = setupRepo({
      triage: LABELS.verifyFailed,
      lastStage: 'verifyFix',
    });
    const { deps, agentCalls } = fakeDeps({
      reviewVerdicts: [PASS_VERDICT],
      verifyResults: [false, true],
    });

    const result = await runIssuePipeline(issue, {
      ...pipelineOptions(root, config, 'verifyFix', deps),
      resumeSession: { stage: 'verifyFix', sessionId: 'sess-9' },
    });

    expect(result.outcome).toBe('completed');
    // The first verifyFix session resumed; the later review session started fresh.
    expect(agentCalls).toEqual([
      expect.objectContaining({ stage: 'verifyFix', resumedSessionId: 'sess-9' }),
      expect.objectContaining({ stage: 'review', resumedSessionId: null }),
    ]);
  });

  it('ignores a resume hint for a stage the pipeline does not enter at', async () => {
    const { root, issue, config } = setupRepo({
      triage: LABELS.verifyFailed,
      lastStage: 'verifyFix',
    });
    const { deps, agentCalls } = fakeDeps({ reviewVerdicts: [PASS_VERDICT], verifyResults: [false, true] });

    await runIssuePipeline(issue, {
      ...pipelineOptions(root, config, 'verifyFix', deps),
      resumeSession: { stage: 'implement', sessionId: 'sess-9' },
    });

    expect(agentCalls.every((call) => call.resumedSessionId === null)).toBe(true);
  });
});

describe('runIssuePipeline stage-boundary parking (ESC x2)', () => {
  it('parks after implement and checkpoints at the gate, not a re-implementation', async () => {
    const { root, issue, config } = setupRepo();
    const { deps, agentCalls } = fakeDeps({});

    const result = await runIssuePipeline(issue, {
      ...pipelineOptions(root, config, 'implement', deps),
      parkRequested: () => true,
    });

    expect(result.outcome).toBe('parked');
    expect(result.fatal).toBeNull();
    expect(result.lastStage).toBe('verifyFix');
    expect(result.finalRole).toBe('agentInterrupted');
    // No verify, no review — the boundary was honoured immediately.
    expect(agentCalls.map((call) => call.stage)).toEqual(['implement']);
    // The checkpoint is on disk, so the next `loop run` resumes at the gate.
    expect(issueFileContent(issue)).toContain('lastStage: verifyFix');
    expect(issueFileContent(issue)).toContain(`triage: ${LABELS.agentInterrupted}`);
  });

  it('parks after a verify-fix cycle whose gate still fails', async () => {
    const { root, issue, config } = setupRepo();
    // implement → verify fails → fix cycle 1 → verify still fails → boundary.
    const { deps, agentCalls } = fakeDeps({ verifyResults: [false, false, true] });

    let sessions = 0;
    const result = await runIssuePipeline(issue, {
      ...pipelineOptions(root, config, 'implement', deps),
      // Park only once the first fix cycle has run, so implement completes normally.
      parkRequested: () => sessions >= 2,
      onStage: () => {
        sessions += 1;
      },
    });

    expect(result.outcome).toBe('parked');
    expect(result.lastStage).toBe('verifyFix');
    expect(agentCalls.map((call) => call.stage)).toEqual(['implement', 'verifyFix']);
  });

  it('parks after a blocking review, resuming straight into the fix pass', async () => {
    const { root, issue, config } = setupRepo();
    const { deps, agentCalls } = fakeDeps({ reviewVerdicts: [BLOCKING_VERDICT, PASS_VERDICT] });

    let reviewed = false;
    const result = await runIssuePipeline(issue, {
      ...pipelineOptions(root, config, 'implement', deps),
      parkRequested: () => reviewed,
      onStage: (stage) => {
        if (stage === 'review') reviewed = true;
      },
    });

    expect(result.outcome).toBe('parked');
    expect(result.lastStage).toBe('reviewFix');
    // The blocking findings were persisted before the boundary, so the resume
    // enters the fix pass rather than paying for a second review.
    expect(readPendingReviewFeedback(root, issue)).toContain('blocking issue found');
    expect(agentCalls.map((call) => call.stage)).toEqual(['implement', 'review']);
  });

  it('does not park a run that nobody asked to stop', async () => {
    const { root, issue, config } = setupRepo();
    const { deps } = fakeDeps({ reviewVerdicts: [PASS_VERDICT] });

    const result = await runIssuePipeline(issue, {
      ...pipelineOptions(root, config, 'implement', deps),
      parkRequested: () => false,
    });

    expect(result.outcome).toBe('completed');
  });
});

describe('runIssuePipeline declared verify (project mode)', () => {
  /** Records the command every verify run was given. */
  function verifyTrackingDeps(reviewVerdicts: string[]): { deps: PipelineDeps; commands: string[] } {
    const commands: string[] = [];
    const base = fakeDeps({ reviewVerdicts });
    return {
      commands,
      deps: {
        ...base.deps,
        runVerifyCommand: (cmd, ...rest) => {
          commands.push(cmd);
          return base.deps.runVerifyCommand(cmd, ...(rest as [string, string, never]));
        },
      },
    };
  }

  it('ignores a declaration for a project that opted out', async () => {
    const { root, issue, config } = setupRepo();
    writeDeclaredVerifyCmd(root, 'PRD-001', 'issue-01', 'true');
    const { deps, commands } = verifyTrackingDeps([PASS_VERDICT]);

    await runIssuePipeline(
      issue,
      pipelineOptions(root, { ...config, allowDeclaredVerify: false }, 'implement', deps),
    );

    expect(commands).toContain('fake-verify');
    expect(commands).not.toContain('true');
  });

  it('gates on the declared command by default', async () => {
    const { root, issue, config } = setupRepo();
    writeDeclaredVerifyCmd(root, 'PRD-001', 'issue-01', 'declared-verify');
    const { deps, commands } = verifyTrackingDeps([PASS_VERDICT]);

    const result = await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));

    expect(result.outcome).toBe('completed');
    expect(commands).toContain('declared-verify');
    expect(commands).not.toContain('fake-verify');
  });

  it('tells the implement session the deal, naming the configured gate', async () => {
    const { root, issue, config } = setupRepo();
    const { deps, agentCalls } = fakeDeps({ reviewVerdicts: [PASS_VERDICT] });

    await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));

    const implementPrompt = agentCalls.find((call) => call.stage === 'implement')!.prompt;
    expect(implementPrompt).toContain('the exception, not the routine');
    expect(implementPrompt).toContain('fake-verify');
    // Fence 3, stated to the session that might otherwise try to narrow the gate.
    expect(implementPrompt).toContain('configured command still runs after the merge');
  });

  it('shows the review both commands and what to block on', async () => {
    const { root, issue, config } = setupRepo();
    writeDeclaredVerifyCmd(root, 'PRD-001', 'issue-01', 'declared-verify');
    const { deps, agentCalls } = fakeDeps({ reviewVerdicts: [PASS_VERDICT] });

    await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));

    const reviewPrompt = agentCalls.find((call) => call.stage === 'review')!.prompt;
    expect(reviewPrompt).toContain('replaced the verify command');
    expect(reviewPrompt).toContain('fake-verify');
    expect(reviewPrompt).toContain('declared-verify');
    expect(reviewPrompt).toContain('merely easier to pass');
  });

  it('applies a declaration the implement session itself wrote, without waiting a cycle', async () => {
    // The realistic path, and the one the feature exists for: nothing is
    // declared when the pipeline starts, and the session declares mid-issue.
    const { root, issue, config } = setupRepo();
    const commands: string[] = [];
    const base = fakeDeps({ reviewVerdicts: [PASS_VERDICT] });
    const deps: PipelineDeps = {
      runAgent: async (prompt, opts) => {
        if (opts.stage === 'implement') {
          writeDeclaredVerifyCmd(root, 'PRD-001', 'issue-01', 'declared-mid-issue');
        }
        return base.deps.runAgent(prompt, opts);
      },
      runVerifyCommand: (cmd, ...rest) => {
        commands.push(cmd);
        return base.deps.runVerifyCommand(cmd, ...(rest as [string, string, never]));
      },
    };

    await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));

    // The very first verify already uses it — not the one after a fix cycle.
    expect(commands[0]).toBe('declared-mid-issue');
    expect(commands).not.toContain('fake-verify');
  });

  it('never applies a replacement silently', async () => {
    const { root, issue, config } = setupRepo();
    writeDeclaredVerifyCmd(root, 'PRD-001', 'issue-01', 'declared-verify');
    const { deps } = fakeDeps({ reviewVerdicts: [PASS_VERDICT] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runIssuePipeline(issue, pipelineOptions(root, config, 'implement', deps));
      const said = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(said).toContain('VERIFY COMMAND REPLACED');
    } finally {
      log.mockRestore();
    }
  });
});
