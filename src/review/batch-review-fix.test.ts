/**
 * Batch review --fix loop: reviewIssueInBatch with mocked pipeline deps.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRunResult } from '../agent/run-agent.js';
import { DEFAULT_CONFIG } from '../config/load-config.js';
import { DEFAULT_TRIAGE_LABELS } from '../config/triage-labels.js';
import type { LoopConfig } from '../config/types.js';
import { cleanupFixtureRepos, createFixtureRepo, gitOrThrow } from '../git/test-helpers.js';
import { discoverIssues } from '../issues/discovery.js';
import type { IssueRecord } from '../issues/types.js';
import type { PipelineDeps } from '../pipeline/deps.js';
import type { ShellVerifyResult } from '../verify/run-verify.js';
import { reviewIssueInBatch } from './batch.js';

afterEach(() => {
  cleanupFixtureRepos();
});

const LABELS = DEFAULT_TRIAGE_LABELS;

const PASS_VERDICT = ['## Loop verdict', 'changes-requested: no', 'severity: none', 'summary: ok'].join('\n');
const BLOCKING_VERDICT = [
  '## Spec',
  'Missing error handling.',
  '',
  '## Loop verdict',
  'changes-requested: yes',
  'severity: blocking',
  'summary: add error handling',
  '',
  '## Loop finding families',
  '- `error-contract`: Every independent failure preserves the public error contract.',
].join('\n');
const FIX_COVERAGE = [
  '## Loop fix coverage',
  '- `error-contract` — invariant: preserved; central fix: shared error seam; sibling cases audited: all branches; tests: focused regression.',
].join('\n');

function agentOk(text: string): AgentRunResult {
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

function setupIssue(): { root: string; issue: IssueRecord; config: LoopConfig } {
  const root = createFixtureRepo('loop-batch-fix-');
  const relPath = path.join('issues', 'PRD-001', 'issue-01.md');
  const content = `---
id: issue-01
title: Batch fix test
triage: ${LABELS.readyForAgent}
---
## Acceptance criteria

- [x] works
`;
  const filePath = path.join(root, relPath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  gitOrThrow(['add', '.'], root);
  gitOrThrow(['commit', '-m', 'chore: add issue'], root);

  const config: LoopConfig = { ...DEFAULT_CONFIG, verifyCmd: 'fake-verify', maxReviewCycles: 2 };
  const issue = discoverIssues(config.issuesDir, root).find((item) => item.qualifiedId === 'PRD-001/issue-01')!;
  return { root, issue, config };
}

describe('reviewIssueInBatch with --fix', () => {
  it('loops review → fix → verify → satisfied when blocking then pass', async () => {
    const { root, issue, config } = setupIssue();
    const reviewVerdicts = [BLOCKING_VERDICT, PASS_VERDICT];
    const agentStages: string[] = [];
    const verifyCalls: string[] = [];

    const deps: PipelineDeps = {
      runAgent: async (_prompt, opts) => {
        agentStages.push(opts.stage);
        if (opts.stage === 'review') {
          return agentOk(reviewVerdicts.shift() ?? PASS_VERDICT);
        }
        return agentOk(FIX_COVERAGE);
      },
      runVerifyCommand: (cmd, cwd, logPath): ShellVerifyResult => {
        verifyCalls.push(`${cmd}@${cwd}`);
        mkdirSync(path.dirname(logPath), { recursive: true });
        writeFileSync(logPath, 'ok\n');
        return { ok: true, output: 'ok', code: 0 };
      },
    };

    const outcome = await reviewIssueInBatch(issue, {
      config,
      labels: LABELS,
      root,
      cwd: root,
      withFix: true,
      verifyCmd: config.verifyCmd,
      liveOutput: false,
      deps,
    });

    expect(outcome).toEqual({ status: 'satisfied' });
    expect(agentStages).toEqual(['review', 'reviewFix', 'review']);
    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0]).toContain(root);
  });

  it('returns fatal with code 2 when review hits usage limit', async () => {
    const { root, issue, config } = setupIssue();
    const deps: PipelineDeps = {
      runAgent: async () => ({
        ok: false,
        output: "You've hit your usage limit",
        usageLimited: true,
        usageLimitDetails: { scope: 'session', resetsAtMs: null },
        stuckReason: null,
        usage: null,
        costUsd: null,
        provenCommands: [],
        agentCli: 'cursor',
        model: 'auto',
      }),
      runVerifyCommand: () => ({ ok: true, output: '', code: 0 }),
    };

    const outcome = await reviewIssueInBatch(issue, {
      config,
      labels: LABELS,
      root,
      cwd: root,
      withFix: true,
      verifyCmd: config.verifyCmd,
      liveOutput: false,
      deps,
    });

    expect(outcome).toEqual({
      status: 'fatal',
      reason: `usage limit hit during review of ${issue.qualifiedId}`,
      code: 2,
    });
  });

  it('prints no verdict when the session died before giving one', async () => {
    const { root, issue, config } = setupIssue();
    const deps: PipelineDeps = {
      runAgent: async () => ({
        ok: false,
        output: "You've hit your session limit \u00b7 resets 1:20am (Australia/Brisbane)",
        usageLimited: true,
        usageLimitDetails: { scope: 'session', resetsAtMs: null },
        stuckReason: null,
        usage: null,
        costUsd: null,
        provenCommands: [],
        agentCli: 'cursor',
        model: 'auto',
      }),
      runVerifyCommand: () => ({ ok: true, output: '', code: 0 }),
    };

    let printed = '';
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
      printed += `${args.join(' ')}\n`;
    });
    try {
      await reviewIssueInBatch(issue, {
        config,
        labels: LABELS,
        root,
        cwd: root,
        withFix: true,
        verifyCmd: config.verifyCmd,
        liveOutput: false,
        deps,
      });
    } finally {
      log.mockRestore();
    }

    // An empty body parses to the safe default — changes requested — which is
    // right for the pipeline but reads as the reviewer's judgement when printed.
    expect(printed).not.toContain('CHANGES REQUESTED');
    expect(printed).toContain('NO REVIEW VERDICT');
    expect(printed).toContain('usage limit');
  });

  it('escalates to needs-human when review cycles are exhausted', async () => {
    const { root, issue, config } = setupIssue();
    const oneCycle = { ...config, maxReviewCycles: 1 };

    const deps: PipelineDeps = {
      runAgent: async (_prompt, opts) => {
        if (opts.stage === 'review') return agentOk(BLOCKING_VERDICT);
        return agentOk(FIX_COVERAGE);
      },
      runVerifyCommand: () => ({ ok: true, output: '', code: 0 }),
    };

    const outcome = await reviewIssueInBatch(issue, {
      config: oneCycle,
      labels: LABELS,
      root,
      cwd: root,
      withFix: true,
      verifyCmd: oneCycle.verifyCmd,
      liveOutput: false,
      deps,
    });

    expect(outcome.status).toBe('escalated');
    const content = readFileSync(issue.filePath, 'utf8');
    expect(content).toContain(`triage: ${LABELS.readyForHuman}`);
    expect(content).toContain('## Loop escalation');
  });

  it('uses cumulative history and deep-fix mode when a family recurs', async () => {
    const { root, issue, config } = setupIssue();
    const reviewVerdicts = [BLOCKING_VERDICT, BLOCKING_VERDICT, BLOCKING_VERDICT];
    const fixPrompts: string[] = [];
    const reviewPrompts: string[] = [];
    const deps: PipelineDeps = {
      runAgent: async (prompt, opts) => {
        if (opts.stage === 'review') {
          reviewPrompts.push(prompt);
          return agentOk(reviewVerdicts.shift() ?? PASS_VERDICT);
        }
        fixPrompts.push(prompt);
        return agentOk(FIX_COVERAGE);
      },
      runVerifyCommand: () => ({ ok: true, output: '', code: 0 }),
    };

    const outcome = await reviewIssueInBatch(issue, {
      config,
      labels: LABELS,
      root,
      cwd: root,
      withFix: true,
      verifyCmd: config.verifyCmd,
      liveOutput: false,
      deps,
    });

    expect(outcome.status).toBe('escalated');
    expect(fixPrompts).toHaveLength(2);
    expect(fixPrompts[0]).not.toContain('Deep-fix mode');
    expect(fixPrompts[1]).toContain('`error-contract` has recurred across 2 reviews');
    expect(reviewPrompts[1]).toContain('shared error seam');
    expect(readFileSync(issue.filePath, 'utf8')).toContain('`error-contract` (3 reviews)');
  });

  it('fails the fix stage when required family coverage is incomplete', async () => {
    const { root, issue, config } = setupIssue();
    const deps: PipelineDeps = {
      runAgent: async (_prompt, opts) =>
        opts.stage === 'review'
          ? agentOk(BLOCKING_VERDICT)
          : agentOk([
              '## Loop fix coverage',
              '- `error-contract`',
            ].join('\n')),
      runVerifyCommand: () => ({ ok: true, output: '', code: 0 }),
    };

    const outcome = await reviewIssueInBatch(issue, {
      config,
      labels: LABELS,
      root,
      cwd: root,
      withFix: true,
      verifyCmd: config.verifyCmd,
      liveOutput: false,
      deps,
    });

    expect(outcome.status).toBe('fatal');
    expect(outcome).toMatchObject({
      reason: expect.stringContaining('missing or incomplete Loop fix coverage'),
      details: [expect.stringContaining('error-contract'), expect.any(String)],
    });
  });
});
