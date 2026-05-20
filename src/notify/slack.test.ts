import { describe, expect, it } from 'vitest';

import { buildSlackPayload } from './slack.js';
import type { NotifyContext, WebhookEvent } from './webhooks.js';

const context: NotifyContext = { repoRoot: '/repo', project: null };

const usage = [
  {
    stage: 'implement',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    elapsedMs: 134_000,
    costUsd: 1.25,
  },
];

function payload(event: WebhookEvent, ctx: NotifyContext = context) {
  return buildSlackPayload(ctx, event, 'plain fallback');
}

describe('buildSlackPayload', () => {
  it('keeps a plain fallback so a blocks-blind client still shows something', () => {
    const result = payload({ event: 'run-completed', stopReason: 'all-complete', issuesProcessed: 2, issuesEscalated: 0, usage });
    expect(result.text).toBe('plain fallback');
  });

  it('demotes the accounting to a context block under the headline', () => {
    const result = payload({ event: 'run-completed', stopReason: 'all-complete', issuesProcessed: 2, issuesEscalated: 0, usage });
    expect(result.blocks[0]).toMatchObject({ type: 'section' });
    expect(result.blocks[0]?.type === 'section' && result.blocks[0].text.text).toContain(':tada:');
    expect(result.blocks[1]).toMatchObject({ type: 'context' });
    const accounting = result.blocks[1]?.type === 'context' ? result.blocks[1].elements[0]?.text : '';
    expect(accounting).toContain('$1.25');
    expect(accounting).toContain('2m14s');
  });

  it('promotes parked issues and the resume command into the headline', () => {
    const result = payload(
      { event: 'run-completed', stopReason: 'blocked', issuesProcessed: 3, issuesEscalated: 2, usage },
      { repoRoot: '/repo', project: 'PRD-006' },
    );
    const text = result.blocks[0]?.type === 'section' ? result.blocks[0].text.text : '';
    // A truncated phone notification shows the headline and little else.
    expect(text).toContain('2 issue(s) need you');
    expect(text).toContain('loop run --unblock PRD-006');
  });

  it('never signals success for an outcome it does not recognize as good', () => {
    const stopped = payload({ event: 'goal-completed', goal: 'ship-it', outcome: 'blocked', rounds: 4, summary: 'wall hit', usage });
    const text = stopped.blocks[0]?.type === 'section' ? stopped.blocks[0].text.text : '';
    expect(text).toContain(':warning:');
  });

  it('omits the context block entirely when no usage was recorded', () => {
    const result = payload({ event: 'usage-limit', scope: 'weekly', policy: 'stop', resetsAt: null, usage: [] });
    expect(result.blocks).toHaveLength(1);
  });
});
