/**
 * Generic in-process async worker pool for loop's claim → work loops.
 *
 * Claim atomicity: `claim` is a synchronous callback and each worker loop
 * invokes it with no `await` between the invocation and its bookkeeping —
 * because JS is single-threaded, two workers can never observe the same
 * unclaimed item as long as `claim` itself records the claim before
 * returning (e.g. adds the id to a claimed set / flips triage in memory).
 *
 * An idle worker (claim returned null) does not exit while other workers are
 * still active: their completion may unblock new items (a blocker's worktree
 * merging back), so it waits for any worker to finish and re-claims. The
 * pool resolves once every worker is idle and nothing is claimable.
 */

export type ClaimFn<T> = () => T | null;
export type WorkFn<T> = (item: T, workerIndex: number) => Promise<void>;

export async function runWorkerPool<T>(maxWorkers: number, claim: ClaimFn<T>, work: WorkFn<T>): Promise<void> {
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
    throw new Error(`runWorkerPool: maxWorkers must be a positive integer (got ${maxWorkers})`);
  }

  let activeWorkers = 0;
  let waiters: Array<() => void> = [];

  const notifyWorkerFinished = (): void => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  const waitForWorkerFinished = (): Promise<void> => new Promise((resolve) => waiters.push(resolve));

  const workerLoop = async (workerIndex: number): Promise<void> => {
    while (true) {
      // Synchronous claim + bookkeeping — no await before activeWorkers++.
      const item = claim();
      if (item === null) {
        if (activeWorkers === 0) return;
        await waitForWorkerFinished();
        continue;
      }
      activeWorkers += 1;
      try {
        await work(item, workerIndex);
      } finally {
        activeWorkers -= 1;
        notifyWorkerFinished();
      }
    }
  };

  await Promise.all(Array.from({ length: maxWorkers }, (_, index) => workerLoop(index)));
}
