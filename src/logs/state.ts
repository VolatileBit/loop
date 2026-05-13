/** Loop-cursor state persisted at `.loop/state.json` in the main repo root. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { loopDir, statePath } from '../shared/paths.js';

export type LoopState = {
  iterations: number;
  lastIssueId: string | null;
  lastRunAt: string | null;
  stoppedReason: string | null;
};

export function loadState(root: string): LoopState {
  const filePath = statePath(root);
  if (!existsSync(filePath)) {
    return { iterations: 0, lastIssueId: null, lastRunAt: null, stoppedReason: null };
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as LoopState;
}

export function saveState(root: string, state: LoopState): void {
  mkdirSync(loopDir(root), { recursive: true });
  writeFileSync(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
}
