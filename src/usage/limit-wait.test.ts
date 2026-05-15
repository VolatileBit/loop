import { describe, expect, it, vi } from 'vitest';

import { mergeLimitWait, waitForLimitReset, type Clock, type LimitWait } from './limit-wait.js';

/** Deterministic clock: `sleep` advances time instantly. */
function fakeClock(startMs: number): Clock & { nowMs: number } {
  const clock = {
    nowMs: startMs,
    now: () => clock.nowMs,
    sleep: async (ms: number) => {
      clock.nowMs += ms;
    },
  };
  return clock;
}

describe('mergeLimitWait', () => {
  it('wakes when the first independently limited provider becomes available', () => {
    const first = mergeLimitWait(null, { scope: 'session', resetsAtMs: 1000 }, 0);
    expect(first).toEqual({
      scope: 'session',
      resetsAtMs: 1000,
      retryAtMs: 61_000,
    });
    expect(mergeLimitWait(first, { scope: 'weekly', resetsAtMs: 500 }, 0)).toEqual({
      scope: 'weekly',
      resetsAtMs: 500,
      retryAtMs: 60_500,
    });
    expect(mergeLimitWait(first, { scope: 'session', resetsAtMs: null }, 0)).toEqual({
      scope: 'session',
      resetsAtMs: 1000,
      retryAtMs: 61_000,
    });
    expect(mergeLimitWait(null, { scope: 'session', resetsAtMs: null }, 0)).toEqual({
      scope: 'session',
      resetsAtMs: null,
      retryAtMs: 15 * 60_000,
    });
  });

  it('uses the bounded probe cadence for a stale provider reset', () => {
    expect(
      mergeLimitWait(
        null,
        { scope: 'session', resetsAtMs: 1_000 },
        2 * 60_000,
      ),
    ).toEqual({
      scope: 'session',
      resetsAtMs: 1_000,
      retryAtMs: 17 * 60_000,
    });
  });

  it('does not let a later raw provider reset hide an earlier cached retry target', () => {
    expect(
      mergeLimitWait(
        { scope: 'session', resetsAtMs: null, retryAtMs: 10 * 60_000 },
        { scope: 'weekly', resetsAtMs: 20 * 60_000 },
        0,
      ),
    ).toEqual({
      scope: 'session',
      resetsAtMs: null,
      retryAtMs: 10 * 60_000,
    });
  });
});

describe('waitForLimitReset', () => {
  it('sleeps until just past the reported reset and resumes', async () => {
    const clock = fakeClock(0);
    const wait: LimitWait = { scope: 'session', resetsAtMs: 10 * 60_000 };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(waitForLimitReset(wait, clock, () => false)).resolves.toBe('resumed');
    } finally {
      log.mockRestore();
    }
    // Reset + one-minute buffer.
    expect(clock.nowMs).toBeGreaterThanOrEqual(11 * 60_000);
  });

  it('probes on a fixed cadence when no reset time is reported', async () => {
    const clock = fakeClock(0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        waitForLimitReset({ scope: 'session', resetsAtMs: null }, clock, () => false),
      ).resolves.toBe('resumed');
    } finally {
      log.mockRestore();
    }
    expect(clock.nowMs).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it('reports the remaining cached probe delay instead of a fresh 15 minutes', async () => {
    const clock = fakeClock(8 * 60_000);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        waitForLimitReset(
          {
            scope: 'session',
            resetsAtMs: null,
            retryAtMs: 10 * 60_000,
          },
          clock,
          () => false,
        ),
      ).resolves.toBe('resumed');
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('retrying in 2 minutes'),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('describes a stale reported reset as a probe', async () => {
    const clock = fakeClock(2 * 60_000);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        waitForLimitReset(
          { scope: 'session', resetsAtMs: 1_000 },
          clock,
          () => false,
        ),
      ).resolves.toBe('resumed');
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('reset time unavailable or stale'),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('cancels promptly when the stop signal fires mid-wait', async () => {
    const clock = fakeClock(0);
    let cancelled = false;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = waitForLimitReset(
        { scope: 'session', resetsAtMs: 60 * 60_000 },
        {
          now: clock.now,
          sleep: async (ms) => {
            await clock.sleep(ms);
            cancelled = true;
          },
        },
        () => cancelled,
      );
      await expect(result).resolves.toBe('cancelled');
    } finally {
      log.mockRestore();
    }
  });

  it('holds the keep-awake inhibitor for exactly the duration of the wait', async () => {
    const clock = fakeClock(0);
    let released = false;
    let heldDuringSleep: boolean | null = null;
    const withKeepAwake: Clock = {
      now: clock.now,
      sleep: async (ms) => {
        heldDuringSleep ??= !released;
        await clock.sleep(ms);
      },
      keepAwake: () => {
        released = false;
        return () => {
          released = true;
        };
      },
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        waitForLimitReset({ scope: 'session', resetsAtMs: 5 * 60_000 }, withKeepAwake, () => false),
      ).resolves.toBe('resumed');
    } finally {
      log.mockRestore();
    }
    expect(heldDuringSleep).toBe(true);
    expect(released).toBe(true);
  });

  it('gives up instead of sleeping past any plausible limit window', async () => {
    const clock = fakeClock(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        waitForLimitReset({ scope: 'weekly', resetsAtMs: 30 * 86_400_000 }, clock, () => false),
      ).resolves.toBe('gave-up');
    } finally {
      warn.mockRestore();
    }
    expect(clock.nowMs).toBe(0);
  });
});
