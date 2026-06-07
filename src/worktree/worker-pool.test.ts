import { describe, expect, it } from 'vitest';

import { runWorkerPool } from './worker-pool.js';

type FakeIssue = { id: string; blockedBy: string[] };

/** Deferred work handles so tests control exactly when each item "finishes". */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('runWorkerPool', () => {
  it('rejects a non-positive or non-integer worker count', async () => {
    await expect(runWorkerPool(0, () => null, async () => {})).rejects.toThrow(/positive integer/);
    await expect(runWorkerPool(1.5, () => null, async () => {})).rejects.toThrow(/positive integer/);
  });

  it('resolves immediately when there is nothing to claim', async () => {
    let claims = 0;
    await runWorkerPool(
      3,
      () => {
        claims += 1;
        return null;
      },
      async () => {
        throw new Error('work should never run');
      },
    );
    expect(claims).toBe(3);
  });

  it('never double-claims an item across N workers', async () => {
    const unclaimed = Array.from({ length: 20 }, (_, i) => ({ id: `issue-${i}`, blockedBy: [] as string[] }));
    const claimedIds: string[] = [];
    const workedIds: string[] = [];

    const claim = (): FakeIssue | null => {
      const item = unclaimed.shift() ?? null;
      // Bookkeeping happens synchronously inside claim, before returning.
      if (item) claimedIds.push(item.id);
      return item;
    };

    await runWorkerPool(4, claim, async (item) => {
      await tick();
      workedIds.push(item.id);
    });

    expect(claimedIds).toHaveLength(20);
    expect(new Set(claimedIds).size).toBe(20);
    expect(workedIds.sort()).toEqual(claimedIds.slice().sort());
  });

  it('caps concurrency at maxWorkers', async () => {
    const pending = Array.from({ length: 10 }, (_, i) => `item-${i}`);
    let active = 0;
    let peakActive = 0;

    await runWorkerPool(
      3,
      () => pending.shift() ?? null,
      async () => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await tick();
        await tick();
        active -= 1;
      },
    );

    expect(peakActive).toBe(3);
  });

  it('lets an idle worker pick up an item unblocked by another worker finishing', async () => {
    const done = new Set<string>();
    const issues: FakeIssue[] = [
      { id: 'blocker', blockedBy: [] },
      { id: 'dependent', blockedBy: ['blocker'] },
    ];
    const claimed = new Set<string>();
    const blockerWork = createDeferred();
    const workedBy: Record<string, number> = {};

    const claim = (): FakeIssue | null => {
      const candidate = issues.find(
        (issue) => !claimed.has(issue.id) && issue.blockedBy.every((dep) => done.has(dep)),
      );
      if (!candidate) return null;
      claimed.add(candidate.id);
      return candidate;
    };

    const poolPromise = runWorkerPool(2, claim, async (item, workerIndex) => {
      workedBy[item.id] = workerIndex;
      if (item.id === 'blocker') await blockerWork.promise;
      done.add(item.id);
    });

    // Give both workers a chance: one holds "blocker", the other found nothing
    // (dependent is blocked) and is waiting rather than exiting.
    await tick();
    expect(claimed.has('blocker')).toBe(true);
    expect(claimed.has('dependent')).toBe(false);

    blockerWork.resolve();
    await poolPromise;

    expect(claimed.has('dependent')).toBe(true);
    expect(done).toEqual(new Set(['blocker', 'dependent']));
  });

  it('keeps claims atomic even when many workers race over a shared candidate pool', async () => {
    // Every worker sees the same "next" candidate until claim marks it —
    // the single-threaded claim contract is what prevents double-claiming.
    const pool = new Map<string, 'unclaimed' | 'claimed'>(
      Array.from({ length: 50 }, (_, i) => [`issue-${i}`, 'unclaimed'] as const),
    );
    const workRuns: string[] = [];

    const claim = (): string | null => {
      for (const [id, status] of pool) {
        if (status === 'unclaimed') {
          pool.set(id, 'claimed');
          return id;
        }
      }
      return null;
    };

    await runWorkerPool(8, claim, async (id) => {
      await Promise.resolve();
      workRuns.push(id);
    });

    expect(workRuns).toHaveLength(50);
    expect(new Set(workRuns).size).toBe(50);
  });
});
