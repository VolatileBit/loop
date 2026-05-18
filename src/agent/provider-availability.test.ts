import { describe, expect, it } from 'vitest';

import { AgentAvailabilityTracker } from './provider-availability.js';

describe('AgentAvailabilityTracker', () => {
  it('treats a stale reported reset like an unknown reset', () => {
    let nowMs = 10 * 60_000;
    const availability = new AgentAvailabilityTracker(() => nowMs);

    const limited = availability.markLimited('codex', {
      scope: 'session',
      resetsAtMs: nowMs - 2 * 60_000,
    });

    expect(limited.retryAtMs).toBe(nowMs + 15 * 60_000);
    expect(availability.isAvailable('codex')).toBe(false);
    nowMs += 15 * 60_000;
    expect(availability.isAvailable('codex')).toBe(true);
  });
});
