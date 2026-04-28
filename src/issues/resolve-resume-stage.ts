/**
 * Resumable stage checkpoints. The `lastStage` frontmatter field records
 * which pipeline stage loop was last working on (written as the stage
 * *begins*); on re-pick of a failed issue, the pipeline resumes there
 * instead of restarting from implement.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import type { PipelineStageName } from '../config/types.js';
import type { TriageLabels, TriageRole } from '../config/triage-labels.js';
import { roleForLabel } from '../config/triage-labels.js';
import type { IssueRecord } from './types.js';

export type Stage = PipelineStageName;

/** Runnable roles that honor an existing checkpoint rather than restarting. */
const RESUMABLE_ROLES: readonly TriageRole[] = [
  'readyForAgent',
  'inProgress',
  'verifyFailed',
  'agentFailed',
  'agentInterrupted',
];

/**
 * Where the per-issue pipeline should enter: any runnable issue with a
 * recorded `lastStage` resumes there. Fresh issues and non-runnable roles
 * start at `implement`; clearing `lastStage` explicitly requests a restart.
 */
export function resolveResumeStage(issue: IssueRecord, labels: TriageLabels): Stage {
  const role = roleForLabel(issue.triage, labels);
  if (role !== null && RESUMABLE_ROLES.includes(role) && issue.lastStage !== undefined) {
    return issue.lastStage;
  }
  return 'implement';
}

/** Write/update the `lastStage:` frontmatter field on the issue file. */
export function setIssueStage(issue: IssueRecord, stage: Stage): void {
  const content = readFileSync(issue.filePath, 'utf8');
  let updated: string;
  if (/^lastStage: .*$/m.test(content)) {
    updated = content.replace(/^lastStage: .*$/m, `lastStage: ${stage}`);
  } else {
    // Insert just before the closing frontmatter delimiter.
    updated = content.replace(/^(---\r?\n[\s\S]*?)(\r?\n---\r?\n)/, `$1\nlastStage: ${stage}$2`);
  }
  if (updated !== content) writeFileSync(issue.filePath, updated);
  issue.lastStage = stage;
}

/** Remove the `lastStage:` frontmatter field, if present. */
export function clearIssueStage(issue: IssueRecord): void {
  const content = readFileSync(issue.filePath, 'utf8');
  const updated = content.replace(/^lastStage: .*\r?\n/m, '');
  if (updated !== content) writeFileSync(issue.filePath, updated);
  delete issue.lastStage;
}
