/**
 * Verify skipping, before the evidence tracker.
 *
 * The first attempt never looked at what the session actually ran: it hashed
 * the tree before and after, and skipped the gate when nothing had changed.
 * That is sound only if the gate is a pure function of the tree, which it is
 * not — a flaky suite, a clock-dependent test, or a verify command that talks
 * to a database all break it. It also cannot tell "nothing changed because the
 * work was already done" from "nothing changed because the session did nothing".
 */

import { createHash } from 'node:crypto';

/** One tracked file, as cheaply as it can be described without reading it. */
export type TreeEntry = {
  path: string;
  size: number;
  mtimeMs: number;
};

/**
 * Order-independent digest of a file listing. Sorting matters: readdir order is
 * filesystem-dependent, and a run whose only difference was directory ordering
 * used to look like a real change.
 */
export function hashTree(entries: readonly TreeEntry[]): string {
  const hash = createHash('sha256');
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    hash.update(`${entry.path} ${entry.size} ${Math.trunc(entry.mtimeMs)}\n`);
  }
  return hash.digest('hex');
}

export type SkipDecision = {
  skip: boolean;
  reason: string;
};

/**
 * Whether the gate can be skipped. `lastVerifiedHash` is the tree digest as of
 * the last green verify; null means the gate has never passed here, so it has
 * to run whatever the tree looks like.
 */
export function decideSkip(currentHash: string, lastVerifiedHash: string | null): SkipDecision {
  if (lastVerifiedHash === null) {
    return { skip: false, reason: 'no previously verified tree to compare against' };
  }
  if (currentHash !== lastVerifiedHash) {
    return { skip: false, reason: 'tree changed since the last green verify' };
  }
  return { skip: true, reason: 'tree identical to the last green verify' };
}

/** One-line note for the run log, so a skip is never silent. */
export function describeSkip(decision: SkipDecision, command: string): string {
  return decision.skip
    ? `skipping \`${command}\` — ${decision.reason}`
    : `running \`${command}\` — ${decision.reason}`;
}
