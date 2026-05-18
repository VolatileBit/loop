import { describe, expect, it, vi } from 'vitest';

import type { StageUsage } from '../usage/tokens.js';
import { buildEventMessage, createNotifier, expandEnv, summarizeUsage, usageLimitEvent, type FetchLike } from './webhooks.js';

const USAGE: StageUsage[] = [
  { stage: 'implement', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.25 },
  { stage: 'review-round-1', inputTokens: 400, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
];

const CONTEXT = { repoRoot: '/repo', project: 'PRD-006' };

describe('expandEnv', () => {
  it('resolves ${VAR} references from the environment', () => {
    expect(expandEnv('https://hooks.example/${TOKEN}/x', { TOKEN: 'abc' })).toBe('https://hooks.example/abc/x');
  });

  it('returns null when any referenced variable is unset', () => {
    expect(expandEnv('https://hooks.example/${MISSING}', {})).toBeNull();
  });

  it('passes through values without references', () => {
    expect(expandEnv('https://hooks.example/x', {})).toBe('https://hooks.example/x');
  });
});

describe('summarizeUsage / buildEventMessage', () => {
  it('summarizes tokens and shows cost only when some CLI reported one', () => {
    expect(summarizeUsage(USAGE)).toBe('2K tokens · $1.25');
    expect(summarizeUsage([USAGE[1]!])).toBe('500 tokens');
  });

  it('builds per-event messages with the project prefix', () => {
    expect(
      buildEventMessage(CONTEXT, {
        event: 'issue-completed',
        issue: { qualifiedId: 'PRD-006/issue-07', title: 'Add timeouts' },
        usage: USAGE,
      }),
    ).toContain('loop [PRD-006] issue PRD-006/issue-07 done — Add timeouts');

    const escalated = buildEventMessage(CONTEXT, {
      event: 'issue-escalated',
      issue: { qualifiedId: 'PRD-006/issue-07', title: 'Add timeouts' },
      outcome: 'needs-human',
      usage: USAGE,
    });
    expect(escalated).toContain('needs a human (needs-human)');
    expect(escalated).toContain('loop run --unblock PRD-006');

    expect(
      buildEventMessage({ repoRoot: '/repo', project: null }, {
        event: 'run-completed',
        stopReason: 'all-complete',
        issuesProcessed: 3,
        issuesEscalated: 0,
        usage: USAGE,
      }),
    ).toContain('backlog complete');

    expect(
      buildEventMessage(CONTEXT, {
        event: 'fix-nits-completed',
        outcome: 'done',
        fixed: 2,
        dismissed: 1,
        usage: USAGE,
      }),
    ).toContain('fix-nits done (2 fixed, 1 dismissed)');
  });

  it('builds the usage-limit event and its message', () => {
    const event = usageLimitEvent({ scope: 'weekly', resetsAtMs: Date.UTC(2026, 6, 20) }, 'stop', USAGE);
    expect(event).toMatchObject({ event: 'usage-limit', scope: 'weekly', policy: 'stop' });
    expect(event.event === 'usage-limit' && event.resetsAt).toBe(new Date(Date.UTC(2026, 6, 20)).toISOString());
    const message = buildEventMessage(CONTEXT, event);
    expect(message).toContain('stopped on the weekly usage limit (policy: stop)');
    expect(message).toContain('resets');

    const noReset = usageLimitEvent(null, 'wait', USAGE);
    expect(noReset).toMatchObject({ event: 'usage-limit', scope: 'session', resetsAt: null });
    expect(buildEventMessage(CONTEXT, noReset)).not.toContain('resets ');
  });
});

describe('createNotifier', () => {
  it('delivers to matching webhooks with the configured format', async () => {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body, headers: init.headers });
      return { ok: true, status: 200 };
    };

    const notify = createNotifier(
      [
        { url: 'https://generic.example/hook', headers: { authorization: 'Bearer ${HOOK_TOKEN}' } },
        { url: 'https://slack.example/hook', format: 'slack' },
        { url: 'https://filtered.example/hook', events: ['run-completed'] },
      ],
      CONTEXT,
      fetchImpl,
    );

    process.env.HOOK_TOKEN = 'sekret';
    try {
      await notify({
        event: 'issue-completed',
        issue: { qualifiedId: 'PRD-006/issue-07', title: 'Add timeouts' },
        usage: USAGE,
      });
    } finally {
      delete process.env.HOOK_TOKEN;
    }

    expect(calls.map((call) => call.url)).toEqual(['https://generic.example/hook', 'https://slack.example/hook']);

    const generic = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(generic.event).toBe('issue-completed');
    expect(generic.project).toBe('PRD-006');
    expect(generic.costUsd).toBe(1.25);
    expect(calls[0]!.headers.authorization).toBe('Bearer sekret');

    // Slack gets blocks plus a plain fallback; the generic payload above must
    // never carry Slack markup, since its consumer may be a pager.
    const slack = JSON.parse(calls[1]!.body) as Record<string, unknown>;
    expect(Object.keys(slack)).toEqual(['text', 'blocks']);
    expect(typeof slack.text).toBe('string');
    expect(Array.isArray(slack.blocks)).toBe(true);
    expect(generic.blocks).toBeUndefined();
  });

  it('skips webhooks whose url references unset env vars, and survives delivery failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const notify = createNotifier(
        [
          { url: 'https://x.example/${DEFINITELY_UNSET_VAR}' },
          { url: 'https://boom.example/hook' },
        ],
        CONTEXT,
        async () => {
          throw new Error('connection refused');
        },
      );
      await expect(
        notify({
          event: 'run-completed',
          stopReason: 'blocked',
          issuesProcessed: 0,
          issuesEscalated: 0,
          usage: [],
        }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unset environment variable'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('delivery failed'));
    } finally {
      warn.mockRestore();
    }
  });
});
