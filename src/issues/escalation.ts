/**
 * Human escalation: flip an issue to the needs-human role and append a
 * `## Loop escalation` note describing what blocked automation.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { TriageLabels } from '../config/triage-labels.js';
import {
  describeConvergenceFailure,
  type ReviewConvergenceSummary,
} from '../review/convergence.js';
import { resolveRoot } from '../shared/paths.js';
import { setIssueTriage } from './lifecycle.js';
import type { IssueRecord } from './types.js';

/** The slice of a review verdict escalation needs (structurally satisfied by review/'s ReviewVerdict). */
export type EscalationVerdict = { summary: string };

export type EscalationOptions = {
  artifactDir: string;
  maxCycles: number;
  labels: TriageLabels;
  root?: string;
  convergence?: ReviewConvergenceSummary;
};

function convergenceEscalationLines(
  convergence: ReviewConvergenceSummary | undefined,
): string[] {
  if (!convergence || convergence.recurringFamilies.length === 0) return [];
  return [
    '',
    'Non-converging root-cause families:',
    ...convergence.recurringFamilies.map(
      (family) =>
        `- \`${family.id}\` (${family.occurrences} reviews; rounds ${family.rounds.join(', ')}) — ${family.invariant}`,
    ),
  ];
}

export function escalateIssueForHuman(
  issue: IssueRecord,
  verdict: EscalationVerdict,
  options: EscalationOptions,
): void {
  const root = options.root ?? resolveRoot();
  setIssueTriage(issue, 'readyForHuman', options.labels);

  const relArtifacts = path.relative(root, options.artifactDir);
  const failure = describeConvergenceFailure(
    options.convergence ?? {
      reviewCount: 0,
      recurringFamilies: [],
      latestFamilies: [],
      reviewsWithoutFamilies: 0,
    },
    options.maxCycles,
  );
  const escalation = [
    '## Loop escalation',
    '',
    `${failure[0]?.toUpperCase()}${failure.slice(1)}.`,
    ...convergenceEscalationLines(options.convergence),
    '',
    `Summary: ${verdict.summary}`,
    '',
    `Review artifacts: \`${relArtifacts}/\` (see \`review.json\` and \`review.md\`).`,
    '',
    `Human action: resolve the blocking findings, then set \`triage: ${options.labels.readyForAgent}\` to retry loop (or use \`loop run --unblock\` to resume at the failed stage).`,
    '',
  ].join('\n');

  const content = readFileSync(issue.filePath, 'utf8');
  const withoutPrior = content.replace(/\n## Loop escalation\n[\s\S]*?(?=\n## |\n*$)/, '');
  writeFileSync(issue.filePath, `${withoutPrior.trimEnd()}\n\n${escalation}`);
}

export type MergeConflictEscalationOptions = {
  branch: string;
  worktreeDir: string;
  conflictingFiles: string[];
  labels: TriageLabels;
};

/**
 * Parallel-runs escalation: the issue's worktree branch could not be merged
 * back into the rolling branch. The worktree/branch are left intact (the only
 * copy of the unmerged work) — a human resolves the conflict manually.
 */
export function escalateIssueForMergeConflict(
  issue: IssueRecord,
  options: MergeConflictEscalationOptions,
): void {
  setIssueTriage(issue, 'readyForHuman', options.labels);

  const files = options.conflictingFiles.length > 0 ? options.conflictingFiles : ['(unknown — see git status in the rolling worktree)'];
  const escalation = [
    '## Loop escalation',
    '',
    `Merging branch \`${options.branch}\` back into the rolling worktree conflicted.`,
    '',
    'Conflicting files:',
    ...files.map((file) => `- \`${file}\``),
    '',
    `The issue worktree is left intact at \`${options.worktreeDir}\` — it holds the only copy of the unmerged work.`,
    '',
    `Human action: resolve the merge manually (merge \`${options.branch}\` into the rolling branch), delete the branch/worktree, then set \`triage: ${options.labels.readyForAgent}\` (or use \`loop run --unblock\`).`,
    '',
  ].join('\n');

  const content = readFileSync(issue.filePath, 'utf8');
  const withoutPrior = content.replace(/\n## Loop escalation\n[\s\S]*?(?=\n## |\n*$)/, '');
  writeFileSync(issue.filePath, `${withoutPrior.trimEnd()}\n\n${escalation}`);
}

export type SemanticConflictEscalationOptions = {
  branch: string;
  worktreeDir: string;
  verifyCmd: string;
  verifyLogPath: string;
  labels: TriageLabels;
};

/**
 * Parallel-runs escalation: the merge itself was textually clean, but the
 * verify command failed against the *merged* rolling state (a sibling issue
 * merged first and the combination is semantically broken). The merge was
 * rewound — rolling stays green — and the worktree/branch are preserved.
 */
export function escalateIssueForSemanticConflict(
  issue: IssueRecord,
  options: SemanticConflictEscalationOptions,
): void {
  setIssueTriage(issue, 'readyForHuman', options.labels);

  const escalation = [
    '## Loop escalation',
    '',
    `Branch \`${options.branch}\` merged cleanly, but \`${options.verifyCmd}\` failed against the merged rolling state — a sibling issue that merged first conflicts semantically with this work. The merge was rewound; the rolling branch is unchanged.`,
    '',
    `Verify output: \`${options.verifyLogPath}\``,
    '',
    `The issue worktree is left intact at \`${options.worktreeDir}\`.`,
    '',
    `Human action: adapt this issue's work to the sibling change (rebase the worktree on the current rolling branch and fix the failures), then set \`triage: ${options.labels.readyForAgent}\` (or use \`loop run --unblock\`).`,
    '',
  ].join('\n');

  const content = readFileSync(issue.filePath, 'utf8');
  const withoutPrior = content.replace(/\n## Loop escalation\n[\s\S]*?(?=\n## |\n*$)/, '');
  writeFileSync(issue.filePath, `${withoutPrior.trimEnd()}\n\n${escalation}`);
}

export type UnverifiableEscalationOptions = {
  /** Absolute path the implement session should have declared the verify command to. */
  declareVerifyPath: string;
  labels: TriageLabels;
};

/**
 * Goal-mode escalation: the implement session declared no verify command, so
 * its work cannot be gated. Pass/fail stays decided by executed commands,
 * never agent prose — an unverifiable issue goes to a human.
 */
export function escalateIssueUnverifiable(
  issue: IssueRecord,
  options: UnverifiableEscalationOptions,
): void {
  setIssueTriage(issue, 'readyForHuman', options.labels);

  const escalation = [
    '## Loop escalation',
    '',
    'The implement session declared **no verify command** for this goal issue, so loop cannot gate its work (goal mode has no configured `verifyCmd` — each issue declares its own).',
    '',
    `Human action: review the work; if it is sound, write the gating command (one line, bare) to \`${options.declareVerifyPath}\` and run \`loop run --unblock\` — the retry resumes at the verify stage. Otherwise fix or discard the work and reset triage yourself.`,
    '',
  ].join('\n');

  const content = readFileSync(issue.filePath, 'utf8');
  const withoutPrior = content.replace(/\n## Loop escalation\n[\s\S]*?(?=\n## |\n*$)/, '');
  writeFileSync(issue.filePath, `${withoutPrior.trimEnd()}\n\n${escalation}`);
}

export function printHumanInterventionRequired(
  issue: IssueRecord,
  verdict: EscalationVerdict,
  options: {
    artifactDir: string;
    labels: TriageLabels;
    root?: string;
    convergence?: ReviewConvergenceSummary;
  },
): void {
  const root = options.root ?? resolveRoot();
  console.error(`\nHuman intervention required for ${issue.qualifiedId}.`);
  console.error(
    `Triage set to ${options.labels.readyForHuman} — loop will skip this issue until you reset triage (or run with --unblock).`,
  );
  console.error(`Review summary: ${verdict.summary}`);
  for (const line of convergenceEscalationLines(options.convergence)) {
    if (line) console.error(line);
  }
  console.error(`Artifacts: ${path.relative(root, options.artifactDir)}/`);
}
