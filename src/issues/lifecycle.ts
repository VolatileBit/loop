/**
 * Issue lifecycle predicates and triage transitions — all role-based via a
 * resolved TriageLabels map, never literal label strings, so a repo's
 * configured vocabulary is honored everywhere.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { roleForLabel, type TriageLabels, type TriageRole } from '../config/triage-labels.js';
import { allCriteriaChecked } from './frontmatter.js';
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

/**
 * Roles where loop is not waiting on anyone. The line is exactly that: `done`
 * and `wontfix` need nothing further, and `delegated` is somebody else's now —
 * whereas `needs-human`, `needs-info` and `needs-triage` are all loop waiting
 * on a person. A backlog whose remainder is settled is complete; reporting it
 * as blocked sends an operator to investigate an obstruction that isn't there.
 */
export const SETTLED_TRIAGE_ROLES: readonly TriageRole[] = ['done', 'wontfix', 'delegatedToHuman'];

export function isSettled(issue: IssueRecord, labels: TriageLabels): boolean {
  const role = issueTriageRole(issue, labels);
  return role !== null && SETTLED_TRIAGE_ROLES.includes(role);
}

/**
 * Issues whose `triage:` label is in no configured vocabulary. They are
 * silently unrunnable — a typo removes an issue from the backlog with nothing
 * said — so callers report them rather than letting them vanish.
 */
export function issuesWithUnknownTriage(
  issues: readonly IssueRecord[],
  labels: TriageLabels,
): IssueRecord[] {
  return issues.filter((issue) => issueTriageRole(issue, labels) === null);
}

/** Agent checked all criteria and/or set the done label before external verify. */
export function isSelfReportedComplete(issue: IssueRecord, labels: TriageLabels): boolean {
  return isDone(issue, labels) || allCriteriaChecked(issue.acceptanceCriteria);
}

export function isLoopComplete(issue: IssueRecord, verifyOk: boolean, labels: TriageLabels): boolean {
  return isDone(issue, labels) || (verifyOk && allCriteriaChecked(issue.acceptanceCriteria));
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

export function markInProgress(issue: IssueRecord, labels: TriageLabels): void {
  if (issueTriageRole(issue, labels) === 'inProgress') return;
  setIssueTriage(issue, 'inProgress', labels);
}
