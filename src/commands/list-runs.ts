/** `loop list-runs` — print recorded runs from `.loop/runs.jsonl`. */

import { listRuns } from '../logs/run-record.js';
import { resolveRoot } from '../shared/paths.js';

export function listRunsCommand(): never {
  listRuns(resolveRoot());
  process.exit(0);
}
