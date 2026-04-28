/**
 * Issue lifecycle predicates and triage transitions — all role-based via a
 * resolved TriageLabels map, never literal label strings, so a repo's.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { roleForLabel, type TriageLabels, type TriageRole } from '../config/triage-labels.js';
import { clearIssueStage } from './resolve-resume-stage.js';
import type { IssueRecord } from './types.js';

/** Triage roles loop will pick up and work on. */
export const RUNNABLE_TRIAGE_ROLES: readonly TriageRole[] = [
  'readyForAgent',
  'inProgress',
  'verifyFailed',
  'agentFailed',
  'agentInterrupted',
];

/** The issue's triage role under the given label vocabulary (null for unknown labels). */
export function issueTriageRole(issue: IssueRecord, labels: TriageLabels): TriageRole | null {
  return roleForLabel(issue.triage, labels);
}

/** Terminal for scheduling — only loop-confirmed done, not agent-checked boxes alone. */
export function isDone(issue: IssueRecord, labels: TriageLabels): boolean {
  return issueTriageRole(issue, labels) === 'done';
}

export function isRunnableTriage(triage: string, labels: TriageLabels): boolean {
  const role = roleForLabel(triage, labels);
  return role !== null && RUNNABLE_TRIAGE_ROLES.includes(role);
}

/**
 * Rewrite the issue file's `triage:` frontmatter field to the label for
 * `role`. Setting `done` clears the `lastStage` checkpoint. Other roles
 * preserve it so manual triage resets still resume; callers that explicitly
 * want a fresh implementation must clear the checkpoint.
 */
export function setIssueTriage(issue: IssueRecord, role: TriageRole, labels: TriageLabels): void {
  const label = labels[role];
  const content = readFileSync(issue.filePath, 'utf8');
  const updated = content.replace(/^triage: .*$/m, `triage: ${label}`);
  if (updated !== content) writeFileSync(issue.filePath, updated);
  issue.triage = label;

  if (role === 'done') clearIssueStage(issue);
}
