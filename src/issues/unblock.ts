/**
 * `loop run --unblock`: transition every needs-human issue (in project, if a
 * filter is given) back to the runnable failure role matching its recorded
 * `lastStage`, so a resolved external blocker gets loop retrying exactly
 * where it left off — no manual frontmatter editing.
 */

import type { TriageLabels, TriageRole } from '../config/triage-labels.js';
import { issueTriageRole, setIssueTriage } from './lifecycle.js';
import type { Stage } from './resolve-resume-stage.js';
import type { IssueRecord } from './types.js';

export type UnblockTransition = {
  qualifiedId: string;
  fromLabel: string;
  toRole: Extract<TriageRole, 'verifyFailed' | 'agentFailed'>;
  toLabel: string;
  /** The stage the pipeline will resume at once the issue is re-picked. */
  resumeStage: Stage;
};

export type UnblockOptions = {
  labels: TriageLabels;
  /** When true, compute and return the transitions without writing any frontmatter. */
  dryRun?: boolean;
};

export function unblockNeedsHumanIssues(
  issues: IssueRecord[],
  projectFilter: ((issue: IssueRecord) => boolean) | null,
  options: UnblockOptions,
): UnblockTransition[] {
  const { labels } = options;
  const transitions: UnblockTransition[] = [];

  for (const issue of issues) {
    if (projectFilter && !projectFilter(issue)) continue;
    if (issueTriageRole(issue, labels) !== 'readyForHuman') continue;

    // verifyFix failures go back to verifyFailed; everything else (implement,
    // review, reviewFix, or a missing checkpoint defaulting to implement)
    // becomes agentFailed — both runnable roles that resume via lastStage.
    const toRole = issue.lastStage === 'verifyFix' ? 'verifyFailed' : 'agentFailed';
    const transition: UnblockTransition = {
      qualifiedId: issue.qualifiedId,
      fromLabel: issue.triage,
      toRole,
      toLabel: labels[toRole],
      resumeStage: issue.lastStage ?? 'implement',
    };

    if (!options.dryRun) setIssueTriage(issue, toRole, labels);
    transitions.push(transition);
  }

  return transitions;
}
