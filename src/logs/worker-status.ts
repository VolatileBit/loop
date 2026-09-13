/**
 * Compact multi-worker console status block, shown periodically instead of
 * the raw per-line agent stream when `maxParallelRuns > 1`. Pure formatting
 * over per-worker status inputs — no timers or IO here.
 */

import { detail, worker } from './style.js';

export type WorkerStatusEntry = {
  /** `project/id` — the issue the worker is on. */
  qualifiedId: string;
  /** Current pipeline stage label, e.g. `implement`, `verify-fix-1`, `review`. */
  stage: string;
  /** Time since the worker claimed the issue. */
  elapsedMs: number;
  /** Repo-relative path to the worker's live agent log. */
  logPath: string;
};

/** `2m14s`, `0m48s`, `1h02m14s` — compact fixed-shape elapsed time. */
export function formatWorkerElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s` : mmss;
}

/**
 * Render the status block: a header line plus one aligned line per active
 * worker.
 *
 *   [loop] 3/5 workers active
 *     SPEC-006/issue-07  implement     2m14s  log: .loop/runs/SPEC-006/...
 */
export function formatWorkerStatusBlock(workers: WorkerStatusEntry[], maxWorkers: number): string {
  const header = `[loop] ${workers.length}/${maxWorkers} workers active`;
  if (workers.length === 0) return header;

  const rows = workers.map((worker) => ({
    qualifiedId: worker.qualifiedId,
    stage: worker.stage,
    elapsed: formatWorkerElapsed(worker.elapsedMs),
    logPath: worker.logPath,
  }));

  const idWidth = Math.max(...rows.map((row) => row.qualifiedId.length));
  const stageWidth = Math.max(...rows.map((row) => row.stage.length));
  const elapsedWidth = Math.max(...rows.map((row) => row.elapsed.length));

  // One colour per issue, matching the prefix its own log lines carry.
  const lines = rows.map((row) =>
    worker(
      row.qualifiedId,
      `  ${row.qualifiedId.padEnd(idWidth)}  ${row.stage.padEnd(stageWidth)}  ${row.elapsed.padEnd(elapsedWidth)}`,
    ) + detail(`  log: ${row.logPath}`),
  );
  return [header, ...lines].join('\n');
}
