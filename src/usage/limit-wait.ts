/**
 * The `wait` usage-limit policy: once the pool has drained, sleep until the
 * provider's limit window resets, then resume claiming. The reset time comes
 * from the CLI's own message when parseable (see providers/usage-limit.ts);
 * otherwise the run re-probes on a fixed cadence — each probe costs one
 * fast-failing session.
 */

import { spawn } from 'node:child_process';

import type { UsageLimitDetails, UsageLimitScope } from '../agent/providers/usage-limit.js';
import { caution } from '../logs/style.js';

export type LimitWait = {
  scope: UsageLimitScope;
  resetsAtMs: number | null;
  retryAtMs?: number;
};

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * Starts a system sleep inhibitor for the duration of a limit wait; returns
   * the release function. Absent (fake clocks in tests) = no inhibitor.
   */
  keepAwake?: () => () => void;
};

/**
 * macOS: `caffeinate -i` blocks idle sleep while it runs; `-w <pid>` ties its
 * lifetime to this process so a crashed loop never leaves the machine
 * insomniac. Other platforms: no-op (close the lid at your own risk).
 */
export function startKeepAwake(): () => void {
  if (process.platform !== 'darwin') return () => {};
  try {
    const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    child.on('error', () => {});
    return () => {
      try {
        child.kill();
      } catch {
        // Already gone — nothing to release.
      }
    };
  } catch {
    return () => {};
  }
}

export const REAL_CLOCK: Clock = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  keepAwake: startKeepAwake,
};

/** Resets often land exactly on the boundary; resuming a minute late beats a second limit hit. */
const RESET_BUFFER_MS = 60_000;
/** With no reset time reported, retry cadence — each probe costs one fast-failing session. */
const PROBE_INTERVAL_MS = 15 * 60_000;
/** Longer than any real limit window (weekly ≈ 7d); beyond this the timestamp is garbage. */
const MAX_WAIT_MS = 8 * 86_400_000;
/** Wait in short slices so a stop request still cancels promptly mid-wait. */
const WAIT_SLICE_MS = 5_000;

/** Effective time at which Loop will next try a provider after this limit. */
export function usageLimitRetryTargetMs(
  wait: Pick<LimitWait, 'resetsAtMs' | 'retryAtMs'>,
  nowMs: number,
): number {
  if (wait.retryAtMs !== undefined) return wait.retryAtMs;
  const reportedTarget =
    wait.resetsAtMs !== null ? wait.resetsAtMs + RESET_BUFFER_MS : null;
  return reportedTarget !== null && reportedTarget > nowMs
    ? reportedTarget
    : nowMs + PROBE_INTERVAL_MS;
}

/**
 * Provider chains recover independently. Once parallel workers have drained,
 * wake at the first effective retry target so routing can use whichever
 * configured provider becomes available first.
 */
export function mergeLimitWait(
  current: LimitWait | null,
  incoming: UsageLimitDetails,
  nowMs: number,
): LimitWait {
  const incomingRetryAtMs = usageLimitRetryTargetMs(incoming, nowMs);
  const incomingWait: LimitWait = {
    ...incoming,
    retryAtMs: incomingRetryAtMs,
  };
  if (!current) return incomingWait;
  const currentRetryAtMs = usageLimitRetryTargetMs(current, nowMs);
  return currentRetryAtMs <= incomingRetryAtMs
    ? { ...current, retryAtMs: currentRetryAtMs }
    : incomingWait;
}

export async function waitForLimitReset(
  wait: LimitWait,
  clock: Clock,
  isCancelled: () => boolean,
): Promise<'resumed' | 'cancelled' | 'gave-up'> {
  const startedAt = clock.now();
  const target = usageLimitRetryTargetMs(wait, startedAt);
  if (target - startedAt > MAX_WAIT_MS) {
    console.warn(
      `[loop] ${wait.scope} usage limit reportedly resets at ${new Date(target).toISOString()} — ` +
        'implausibly far away; stopping instead of waiting.',
    );
    return 'gave-up';
  }
  const awakeNote = clock.keepAwake ? ' The machine is kept awake for the wait.' : '';
  const probeMinutes = Math.max(0, Math.ceil((target - startedAt) / 60_000));
  const reportedTarget =
    wait.resetsAtMs !== null ? wait.resetsAtMs + RESET_BUFFER_MS : null;
  const waitsForReportedReset =
    reportedTarget !== null &&
    reportedTarget > startedAt &&
    target === reportedTarget;
  console.log(
    caution(
      waitsForReportedReset
        ? `[loop] usage limit (${wait.scope}) hit — waiting until ${new Date(target).toLocaleString()} ` +
            `for the reset, then resuming.${awakeNote} Press ESC to stop instead.`
        : `[loop] usage limit (${wait.scope}) hit — reset time unavailable or stale; retrying in ` +
            `${probeMinutes} minutes.${awakeNote} Press ESC to stop instead.`,
    ),
  );
  const releaseKeepAwake = clock.keepAwake?.() ?? (() => {});
  try {
    while (clock.now() < target) {
      if (isCancelled()) return 'cancelled';
      await clock.sleep(Math.min(WAIT_SLICE_MS, target - clock.now()));
    }
    return isCancelled() ? 'cancelled' : 'resumed';
  } finally {
    releaseKeepAwake();
  }
}
