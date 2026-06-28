/**
 * Goal-loop integration: real git fixture repo, real goal folder, real
 * pipeline — scripted agent/verify seams. The fake "agent" performs each
 * stage's observable side effects (plan writes an issue file, implement
 * declares the verify command) exactly as a live session would.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentRunResult } from '../agent/run-agent.js';
import { DEFAULT_CONFIG } from '../config/load-config.js';
import { DEFAULT_TRIAGE_LABELS } from '../config/triage-labels.js';
import type { LoopConfig } from '../config/types.js';
import { cleanupFixtureRepos, createFixtureRepo, gitOrThrow } from '../git/test-helpers.js';
import type { WebhookEvent } from '../notify/webhooks.js';
import type { PipelineDeps } from '../pipeline/deps.js';
import { createGoal, declaredVerifyPath, loadGoalState } from './goal.js';
import { executeGoalLoop } from './run-goal.js';

afterEach(cleanupFixtureRepos);

const LABELS = DEFAULT_TRIAGE_LABELS;

const PASS_VERDICT = ['## Loop verdict', 'changes-requested: no', 'severity: none', 'summary: ok'].join('\n');
const REACHED = ['## Loop goal verdict', 'status: reached', 'summary: goal satisfied'].join('\n');
const NOT_REACHED = [
  '## Loop goal verdict',
  'status: not-reached',
  'summary: one gap left',
  '',
  '## Loop goal gaps',
  '- finish the remaining widget',
].join('\n');

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

function agentLimited(scope: 'session' | 'weekly', resetsAtMs: number | null): AgentRunResult {
  return {
    ok: false,
    output: '',
    usageLimited: true,
    usageLimitDetails: { scope, resetsAtMs },
    stuckReason: null,
    usage: null,
    costUsd: null,
    provenCommands: [],
    agentCli: 'cursor',
    model: 'auto',
  };
}

/** Deterministic clock: `sleep` advances time instantly (no keepAwake → no caffeinate). */
function fakeClock(startMs: number): { nowMs: number; now: () => number; sleep: (ms: number) => Promise<void> } {
  const clock = {
    nowMs: startMs,
    now: () => clock.nowMs,
    sleep: async (ms: number) => {
      clock.nowMs += ms;
    },
  };
  return clock;
}

function setup(): { root: string; config: LoopConfig } {
  const root = createFixtureRepo('loop-goal-run-');
  gitOrThrow(['config', 'commit.gpgsign', 'false'], root);
  const config: LoopConfig = { ...DEFAULT_CONFIG, goal: { maxIssuesPerRound: 3, roundLimit: null, supersedeLimit: 3, usageLimits: {} } };
  return { root, config };
}

const GOAL_ISSUE = (id: string) =>
  `---\nid: ${id}\ntitle: Goal issue ${id}\ntriage: ${LABELS.readyForAgent}\n---\n\nDo the thing.\n\n## Acceptance criteria\n\n- [x] works\n`;

describe('executeGoalLoop', () => {
  it('runs plan → drain → evaluate to reached in one round', async () => {
    const { root, config } = setup();
    const paths = createGoal(root, 'g1', 'Make the thing work.');
    const events: WebhookEvent[] = [];
    const stages: string[] = [];

    const deps: PipelineDeps = {
      runAgent: async (_prompt, opts) => {
        stages.push(opts.stage);
        if (opts.stage === 'plan') {
          writeFileSync(path.join(paths.issuesProjectDir, '01-thing.md'), GOAL_ISSUE('01-thing'));
          return agentOk('created 01-thing');
        }
        if (opts.stage === 'implement') {
          writeFileSync(declaredVerifyPath(paths, '01-thing'), 'true\n');
          return agentOk('done');
        }
        if (opts.stage === 'review') return agentOk(PASS_VERDICT);
        if (opts.stage === 'evaluate') return agentOk(REACHED);
        return agentOk('done');
      },
      runVerifyCommand: (cmd) => ({ ok: true, output: `ran ${cmd}`, code: 0 }),
    };

    const result = await executeGoalLoop({
      root,
      workRoot: root,
      config,
      labels: LABELS,
      paths,
      roundLimit: 5,
      budgetUsd: null,
      liveOutput: false,
      notify: async (event) => {
        events.push(event);
      },
      deps,
    });

    expect(result.outcome).toBe('reached');
    expect(result.rounds).toBe(1);
    expect(result.issuesProcessed).toBe(1);
    expect(stages).toEqual(['plan', 'implement', 'review', 'evaluate']);
    expect(loadGoalState(paths).status).toBe('reached');
    // The goal issue completed and the goal webhook fired last.
    expect(readFileSync(path.join(paths.issuesProjectDir, '01-thing.md'), 'utf8')).toContain(
      `triage: ${LABELS.done}`,
    );
    expect(events.map((event) => event.event)).toEqual(['issue-completed', 'goal-completed']);
    // The evaluation verdict is persisted per round.
    expect(readFileSync(path.join(paths.evaluationsDir, 'round-1.md'), 'utf8')).toContain('status: reached');
  });

  it('feeds not-reached gaps into the next plan and stops planner-stuck when nothing new comes', async () => {
    const { root, config } = setup();
    const paths = createGoal(root, 'g2', 'Bigger goal.');
    let planCalls = 0;
    const planPrompts: string[] = [];

    const deps: PipelineDeps = {
      runAgent: async (prompt, opts) => {
        if (opts.stage === 'plan') {
          planCalls += 1;
          planPrompts.push(prompt);
          if (planCalls === 1) {
            writeFileSync(path.join(paths.issuesProjectDir, '01-a.md'), GOAL_ISSUE('01-a'));
            return agentOk('created 01-a');
          }
          return agentOk('no new issues'); // stuck on round 2
        }
        if (opts.stage === 'implement') {
          writeFileSync(declaredVerifyPath(paths, '01-a'), 'true\n');
          return agentOk('done');
        }
        if (opts.stage === 'review') return agentOk(PASS_VERDICT);
        if (opts.stage === 'evaluate') return agentOk(NOT_REACHED);
        return agentOk('done');
      },
      runVerifyCommand: (cmd) => ({ ok: true, output: `ran ${cmd}`, code: 0 }),
    };

    const result = await executeGoalLoop({
      root,
      workRoot: root,
      config,
      labels: LABELS,
      paths,
      roundLimit: 5,
      budgetUsd: null,
      liveOutput: false,
      notify: async () => {},
      deps,
    });

    expect(result.outcome).toBe('planner-stuck');
    expect(result.rounds).toBe(2);
    // Round 2's plan received round 1's gap verbatim.
    expect(planPrompts[1]).toContain('finish the remaining widget');
    expect(loadGoalState(paths).status).toBe('planner-stuck');
  });

  it('escalates unverifiable issues (no declaration) and keeps draining, ending blocked only via lineage', async () => {
    const { root, config } = setup();
    const paths = createGoal(root, 'g3', 'Goal with a stubborn issue.');
    writeFileSync(path.join(paths.issuesProjectDir, '01-a.md'), GOAL_ISSUE('01-a'));
    writeFileSync(path.join(paths.issuesProjectDir, '02-b.md'), GOAL_ISSUE('02-b'));
    const events: WebhookEvent[] = [];

    const deps: PipelineDeps = {
      runAgent: async (_prompt, opts) => {
        if (opts.stage === 'implement') {
          // Only 02-b declares its command; 01-a stays undeclared → unverifiable.
          if (opts.stageLabel.includes('02-b')) {
            writeFileSync(declaredVerifyPath(paths, '02-b'), 'true\n');
          }
          return agentOk('done');
        }
        if (opts.stage === 'review') return agentOk(PASS_VERDICT);
        if (opts.stage === 'evaluate') return agentOk(REACHED);
        return agentOk('done');
      },
      runVerifyCommand: (cmd) => ({ ok: true, output: `ran ${cmd}`, code: 0 }),
    };

    const result = await executeGoalLoop({
      root,
      workRoot: root,
      config,
      labels: LABELS,
      paths,
      roundLimit: 3,
      budgetUsd: null,
      liveOutput: false,
      notify: async (event) => {
        events.push(event);
      },
      deps,
    });

    // 01-a escalated as unverifiable; 02-b completed; the evaluator then judged reached.
    expect(result.outcome).toBe('reached');
    expect(result.issuesEscalated).toEqual(['g3/01-a']);
    expect(events.some((event) => event.event === 'issue-escalated')).toBe(true);
    expect(readFileSync(path.join(paths.issuesProjectDir, '01-a.md'), 'utf8')).toContain(
      `triage: ${LABELS.readyForHuman}`,
    );
    expect(readFileSync(path.join(paths.issuesProjectDir, '01-a.md'), 'utf8')).toContain('no verify command');
  });

  it('drains a parallel goal round through per-issue worktrees and merges both back', async () => {
    const { root, config: baseConfig } = setup();
    const config: LoopConfig = { ...baseConfig, maxParallelRuns: 2 };
    const paths = createGoal(root, 'g7', 'Parallel goal.');
    writeFileSync(path.join(paths.issuesProjectDir, '01-a.md'), GOAL_ISSUE('01-a'));
    writeFileSync(path.join(paths.issuesProjectDir, '02-b.md'), GOAL_ISSUE('02-b'));

    const deps: PipelineDeps = {
      runAgent: async (_prompt, opts) => {
        if (opts.stage === 'implement') {
          const id = opts.stageLabel.includes('01-a') ? '01-a' : '02-b';
          writeFileSync(declaredVerifyPath(paths, id), 'true\n');
          // Real work in the per-issue worktree — must survive the merge back.
          writeFileSync(path.join(opts.cwd, `${id}.txt`), `${id}\n`);
          gitOrThrow(['add', '-A'], opts.cwd);
          gitOrThrow(['commit', '-m', `feat: ${id}`], opts.cwd);
          return agentOk('done');
        }
        if (opts.stage === 'review') return agentOk(PASS_VERDICT);
        if (opts.stage === 'evaluate') return agentOk(REACHED);
        return agentOk('done');
      },
      runVerifyCommand: (cmd) => ({ ok: true, output: `ran ${cmd}`, code: 0 }),
    };

    const result = await executeGoalLoop({
      root,
      workRoot: root,
      config,
      labels: LABELS,
      paths,
      roundLimit: 3,
      budgetUsd: null,
      liveOutput: false,
      notify: async () => {},
      deps,
    });

    expect(result.outcome).toBe('reached');
    expect(result.issuesProcessed).toBe(2);
    // Both worktrees' commits merged back into the goal's work root.
    expect(readFileSync(path.join(root, '01-a.txt'), 'utf8')).toBe('01-a\n');
    expect(readFileSync(path.join(root, '02-b.txt'), 'utf8')).toBe('02-b\n');
    expect(readFileSync(path.join(paths.issuesProjectDir, '01-a.md'), 'utf8')).toContain(`triage: ${LABELS.done}`);
    expect(readFileSync(path.join(paths.issuesProjectDir, '02-b.md'), 'utf8')).toContain(`triage: ${LABELS.done}`);
  });

  it('self-heals verify-failed issues: one retry, then park for a plan supersede', async () => {
    const { root, config: baseConfig } = setup();
    const config: LoopConfig = { ...baseConfig, maxVerifyCycles: 1 };
    const paths = createGoal(root, 'g6', 'Self-healing goal.');
    writeFileSync(path.join(paths.issuesProjectDir, '01-a.md'), GOAL_ISSUE('01-a'));
    let planCalls = 0;

    const deps: PipelineDeps = {
      runAgent: async (_prompt, opts) => {
        if (opts.stage === 'plan') {
          planCalls += 1;
          // Supersede the parked 01-a with a working replacement.
          writeFileSync(
            path.join(paths.issuesProjectDir, '01-a.md'),
            `---\nid: 01-a\ntitle: Goal issue 01-a\ntriage: wontfix\n---\n\nDo the thing.\n`,
          );
          writeFileSync(
            path.join(paths.issuesProjectDir, '02-fix.md'),
            GOAL_ISSUE('02-fix').replace('---\n\nDo the thing.', '---\nSupersedes: 01-a\n\nDo the thing.'),
          );
          return agentOk('superseded 01-a with 02-fix');
        }
        if (opts.stage === 'implement') {
          const id = opts.stageLabel.includes('02-fix') ? '02-fix' : '01-a';
          // 01-a declares a failing gate; the replacement declares a passing one.
          writeFileSync(declaredVerifyPath(paths, id), id === '01-a' ? 'false\n' : 'true\n');
          return agentOk('done');
        }
        if (opts.stage === 'review') return agentOk(PASS_VERDICT);
        if (opts.stage === 'evaluate') return agentOk(NOT_REACHED);
        return agentOk('tried a fix');
      },
      runVerifyCommand: (cmd) => (cmd.trim() === 'false' ? { ok: false, output: 'boom', code: 1 } : { ok: true, output: 'ok', code: 0 }),
    };

    const result = await executeGoalLoop({
      root,
      workRoot: root,
      config,
      labels: LABELS,
      paths,
      roundLimit: 4,
      budgetUsd: null,
      liveOutput: false,
      notify: async () => {},
      deps,
    });

    // Round 1: 01-a verify-fails (attempt 1, silent retry). Round 2: fails
    // again → parked readyForHuman. Round 3: plan supersedes; 02-fix passes.
    // The evaluator is scripted to not-reached, so the run ends at round-limit
    // — the interesting assertions are the healing mechanics themselves.
    expect(planCalls).toBeGreaterThanOrEqual(1);
    const state = loadGoalState(paths);
    expect(state.attempts['01-a']).toBe(2);
    expect(state.lineage['02-fix']).toBe('01-a');
    expect(result.issuesEscalated).toEqual(['g6/01-a']);
    expect(readFileSync(path.join(paths.issuesProjectDir, '01-a.md'), 'utf8')).toContain('triage: wontfix');
    expect(readFileSync(path.join(paths.issuesProjectDir, '02-fix.md'), 'utf8')).toContain(
      `triage: ${LABELS.done}`,
    );
  });

  it('waits out a session limit during a plan session, then retries it and reaches the goal', async () => {
    const { root, config } = setup();
    const paths = createGoal(root, 'g4', 'Limit-then-recover goal.');
    const clock = fakeClock(0);
    let planCalls = 0;

    const deps: PipelineDeps = {
      runAgent: async (_prompt, opts) => {
        if (opts.stage === 'plan') {
          planCalls += 1;
          if (planCalls === 1) return agentLimited('session', 5 * 60_000);
          writeFileSync(path.join(paths.issuesProjectDir, '01-thing.md'), GOAL_ISSUE('01-thing'));
          return agentOk('created 01-thing');
        }
        if (opts.stage === 'implement') {
          writeFileSync(declaredVerifyPath(paths, '01-thing'), 'true\n');
          return agentOk('done');
        }
        if (opts.stage === 'review') return agentOk(PASS_VERDICT);
        if (opts.stage === 'evaluate') return agentOk(REACHED);
        return agentOk('done');
      },
      runVerifyCommand: (cmd) => ({ ok: true, output: `ran ${cmd}`, code: 0 }),
    };

    const result = await executeGoalLoop({
      root,
      workRoot: root,
      config,
      labels: LABELS,
      paths,
      roundLimit: 3,
      budgetUsd: null,
      usageLimits: { session: 'wait', weekly: 'stop' },
      liveOutput: false,
      notify: async () => {},
      clock,
      deps,
    });

    expect(result.outcome).toBe('reached');
    expect(planCalls).toBe(2);
    // Slept past the reported reset (plus the one-minute buffer).
    expect(clock.nowMs).toBeGreaterThanOrEqual(6 * 60_000);
  });

  it('stops and sends the usage-limit webhook on a weekly limit under the stop policy', async () => {
    const { root, config } = setup();
    const paths = createGoal(root, 'g5', 'Weekly-limited goal.');
    const events: WebhookEvent[] = [];

    const deps: PipelineDeps = {
      runAgent: async (_prompt, opts) => {
        if (opts.stage === 'plan') {
          writeFileSync(path.join(paths.issuesProjectDir, '01-thing.md'), GOAL_ISSUE('01-thing'));
          return agentOk('created 01-thing');
        }
        return agentLimited('weekly', null);
      },
      runVerifyCommand: (cmd) => ({ ok: true, output: `ran ${cmd}`, code: 0 }),
    };

    const result = await executeGoalLoop({
      root,
      workRoot: root,
      config,
      labels: LABELS,
      paths,
      roundLimit: 3,
      budgetUsd: null,
      usageLimits: { session: 'wait', weekly: 'stop' },
      liveOutput: false,
      notify: async (event) => {
        events.push(event);
      },
      deps,
    });

    expect(result.outcome).toBe('usage-limit');
    const limitEvents = events.filter((event) => event.event === 'usage-limit');
    expect(limitEvents).toHaveLength(1);
    expect(limitEvents[0]).toMatchObject({ scope: 'weekly', policy: 'stop', resetsAt: null });
    expect(events.at(-1)?.event).toBe('goal-completed');
  });
});
