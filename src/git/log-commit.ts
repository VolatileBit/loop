/**
 * Glue between git/commit.ts and the run record: make loop's per-stage
 * commit, echo the outcome, and append the commit entry to the run context
 * (or a standalone run dir's commits.jsonl when no run context exists, e.g.
 * standalone review sessions).
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { LoopCommitRecord, RunContext } from '../logs/run-context.js';
import { ensureLoopCommit, type CommitSuggestion } from './commit.js';

export type LogLoopCommitOptions = {
  /** Where the commit happens. Defaults to `ctx.workRoot`; required when `ctx` is null. */
  cwd?: string | undefined;
  /** Config-driven `commitExcludePaths`. */
  excludePaths?: string[] | undefined;
  /** Paths dirty before the owning run began. */
  preservePaths?: string[] | undefined;
  /** Standalone commits.jsonl destination when there is no run context. */
  runDir?: string | undefined;
  suggestion?: CommitSuggestion | null | undefined;
};

export function logLoopCommit(
  ctx: RunContext | null,
  qualifiedId: string,
  label: string,
  options: LogLoopCommitOptions = {},
): LoopCommitRecord {
  const cwd = options.cwd ?? ctx?.workRoot;
  if (!cwd) throw new Error('logLoopCommit requires a cwd when no run context is given');

  const result = ensureLoopCommit(qualifiedId, label, {
    cwd,
    excludePaths: options.excludePaths,
    preservePaths: [...(ctx?.preExistingDirtyPaths ?? []), ...(options.preservePaths ?? [])],
    suggestion: options.suggestion,
  });
  const entry: LoopCommitRecord = {
    label,
    message: result.message,
    sha: result.sha,
    committed: result.committed,
    at: new Date().toISOString(),
  };

  if (result.committed) {
    console.log(`[loop] committed ${result.sha?.slice(0, 7) ?? '?'} — ${result.message}`);
    if (result.warning) console.warn(`[loop] ${result.warning.trim().slice(0, 200)}`);
  } else if (result.output === 'working tree clean' || result.output === 'no loop changes to commit') {
    console.log(`[loop] no changes to commit for ${label} (${result.output})`);
  } else if (result.output === 'not a git repository') {
    console.warn('[loop] workspace is not a git repository — changes were not committed.');
  } else {
    console.warn(`[loop] commit failed for ${result.message}: ${result.output.trim().slice(0, 200)}`);
  }

  if (ctx) {
    ctx.commits.push(entry);
    writeFileSync(
      path.join(ctx.runDir, 'commits.jsonl'),
      `${ctx.commits.map((item) => JSON.stringify(item)).join('\n')}\n`,
    );
  } else if (options.runDir) {
    appendFileSync(path.join(options.runDir, 'commits.jsonl'), `${JSON.stringify(entry)}\n`);
  }

  return entry;
}
