/**
 * Structured review data that stays stable across fresh review/fix sessions.
 *
 * Finding-family ids identify the invariant behind one or more concrete
 * findings. Review agents reuse the id while that invariant remains broken,
 * which lets loop distinguish convergence from repeated example-by-example
 * patching.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runsDir } from '../shared/paths.js';
import type { ReviewSeverity, ReviewVerdict } from './verdict.js';

export const LOOP_FINDING_FAMILIES_HEADING = '## Loop finding families';
export const LOOP_FIX_COVERAGE_HEADING = '## Loop fix coverage';

export type ReviewFindingFamily = {
  /** Stable lower-kebab-case id reused while this root cause remains unresolved. */
  id: string;
  /** The behavioral invariant all concrete findings in this family violate. */
  invariant: string;
};

export type ReviewHistoryEntry = {
  issueId: string;
  round: number;
  endedAt: string;
  summary: string;
  severity: ReviewSeverity;
  findingFamilies: ReviewFindingFamily[];
  artifactPath: string;
};

export type ReviewFixCoverageEntry = {
  issueId: string;
  round: number;
  endedAt: string;
  /** Null records that the fix agent omitted the required structured report. */
  body: string | null;
  artifactPath: string;
};

export type ReviewConvergenceHistory = {
  reviews: ReviewHistoryEntry[];
  fixes: ReviewFixCoverageEntry[];
};

export type FindingFamilyRecurrence = ReviewFindingFamily & {
  occurrences: number;
  rounds: number[];
};

export type ReviewConvergenceSummary = {
  reviewCount: number;
  recurringFamilies: FindingFamilyRecurrence[];
  latestFamilies: ReviewFindingFamily[];
  reviewsWithoutFamilies: number;
};

const MAX_DETAILED_HISTORY_EVENTS = 12;
const MAX_FIX_COVERAGE_CHARS = 2_000;

type ReviewHistoryRef = {
  project: string;
  qualifiedId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSeverity(value: unknown): ReviewSeverity | null {
  return value === 'blocking' || value === 'nits-only' || value === 'none' || value === 'unknown'
    ? value
    : null;
}

function parseFindingFamily(value: unknown): ReviewFindingFamily | null {
  if (!isRecord(value)) return null;
  const { id, invariant } = value;
  if (
    typeof id !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
    typeof invariant !== 'string' ||
    invariant.trim().length === 0
  ) {
    return null;
  }
  return { id, invariant: invariant.trim() };
}

function artifactFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...artifactFiles(entryPath));
    else if (entry.isFile() && (entry.name === 'review.json' || entry.name.endsWith('.coverage.json'))) {
      files.push(entryPath);
    }
  }
  return files;
}

function parseReviewEntry(
  value: unknown,
  expectedIssueId: string,
  artifactPath: string,
): ReviewHistoryEntry | null {
  if (!isRecord(value) || value.issueId !== expectedIssueId || value.completed === false) return null;
  const severity = parseSeverity(value.severity);
  if (
    !Number.isInteger(value.round) ||
    typeof value.round !== 'number' ||
    typeof value.endedAt !== 'string' ||
    typeof value.summary !== 'string' ||
    !severity
  ) {
    return null;
  }
  const findingFamilies = Array.isArray(value.findingFamilies)
    ? value.findingFamilies
        .map(parseFindingFamily)
        .filter((family): family is ReviewFindingFamily => family !== null)
    : [];
  return {
    issueId: expectedIssueId,
    round: value.round,
    endedAt: value.endedAt,
    summary: value.summary,
    severity,
    findingFamilies,
    artifactPath,
  };
}

function parseFixCoverageEntry(
  value: unknown,
  expectedIssueId: string,
  artifactPath: string,
): ReviewFixCoverageEntry | null {
  if (!isRecord(value) || value.issueId !== expectedIssueId) return null;
  if (
    !Number.isInteger(value.round) ||
    typeof value.round !== 'number' ||
    typeof value.endedAt !== 'string' ||
    !(typeof value.body === 'string' || value.body === null)
  ) {
    return null;
  }
  return {
    issueId: expectedIssueId,
    round: value.round,
    endedAt: value.endedAt,
    body: typeof value.body === 'string' ? value.body.trim() : null,
    artifactPath,
  };
}

/**
 * Reads the durable convergence ledger from existing per-run artifacts.
 * Malformed/legacy artifacts are tolerated; legacy reviews simply have no
 * structured finding families.
 */
export function loadReviewConvergenceHistory(
  root: string,
  issue: ReviewHistoryRef,
): ReviewConvergenceHistory {
  const projectRunsDir = path.join(runsDir(root), issue.project);
  const reviews: ReviewHistoryEntry[] = [];
  const fixes: ReviewFixCoverageEntry[] = [];

  for (const filePath of artifactFiles(projectRunsDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    const artifactPath = path.relative(root, filePath);
    if (path.basename(filePath) === 'review.json') {
      const review = parseReviewEntry(parsed, issue.qualifiedId, artifactPath);
      if (review) reviews.push(review);
    } else {
      const fix = parseFixCoverageEntry(parsed, issue.qualifiedId, artifactPath);
      if (fix) fixes.push(fix);
    }
  }

  const byTimeThenPath = <T extends { endedAt: string; artifactPath: string }>(a: T, b: T): number =>
    a.endedAt.localeCompare(b.endedAt) || a.artifactPath.localeCompare(b.artifactPath);
  reviews.sort(byTimeThenPath);
  fixes.sort(byTimeThenPath);
  return { reviews, fixes };
}

export function appendReviewToHistory(
  history: ReviewConvergenceHistory,
  options: {
    issueId: string;
    round: number;
    endedAt: string;
    artifactPath: string;
    verdict: ReviewVerdict;
  },
): ReviewConvergenceHistory {
  return {
    reviews: [
      ...history.reviews,
      {
        issueId: options.issueId,
        round: options.round,
        endedAt: options.endedAt,
        summary: options.verdict.summary,
        severity: options.verdict.severity,
        findingFamilies: options.verdict.findingFamilies,
        artifactPath: options.artifactPath,
      },
    ],
    fixes: [...history.fixes],
  };
}

function collectFamilyOccurrences(
  history: ReviewConvergenceHistory,
): Map<string, FindingFamilyRecurrence> {
  const families = new Map<string, FindingFamilyRecurrence>();
  for (const review of history.reviews) {
    const seenInReview = new Set<string>();
    for (const family of review.findingFamilies) {
      if (seenInReview.has(family.id)) continue;
      seenInReview.add(family.id);
      const existing = families.get(family.id);
      if (existing) {
        existing.invariant = family.invariant;
        existing.occurrences += 1;
        existing.rounds.push(review.round);
      } else {
        families.set(family.id, {
          ...family,
          occurrences: 1,
          rounds: [review.round],
        });
      }
    }
  }
  return families;
}

export function summarizeReviewConvergence(
  history: ReviewConvergenceHistory,
): ReviewConvergenceSummary {
  const families = collectFamilyOccurrences(history);
  const latest = history.reviews.at(-1);
  const latestFamilies = [
    ...new Map(
      (latest?.findingFamilies ?? []).map((family) => [family.id, family]),
    ).values(),
  ];
  const latestFamilyIds = new Set(latestFamilies.map((family) => family.id));
  return {
    reviewCount: history.reviews.length,
    recurringFamilies: [...families.values()]
      .filter(
        (family) =>
          family.occurrences >= 2 && latestFamilyIds.has(family.id),
      )
      .sort((a, b) => b.occurrences - a.occurrences || a.id.localeCompare(b.id)),
    latestFamilies,
    reviewsWithoutFamilies: history.reviews.filter(
      (review) => review.severity === 'blocking' && review.findingFamilies.length === 0,
    ).length,
  };
}

export function describeConvergenceFailure(
  summary: ReviewConvergenceSummary,
  maxCycles: number,
): string {
  if (summary.recurringFamilies.length === 0) {
    return `blocking review findings remained after ${maxCycles} review↔implement cycle(s)`;
  }
  const families = summary.recurringFamilies
    .map((family) => `\`${family.id}\` (${family.occurrences} reviews)`)
    .join(', ');
  return `non-converging review families after ${maxCycles} review↔implement cycle(s): ${families}`;
}

export function formatReviewConvergenceHistory(history: ReviewConvergenceHistory): string {
  if (history.reviews.length === 0 && history.fixes.length === 0) return '';

  const familyOccurrences = [...collectFamilyOccurrences(history).values()].sort(
    (a, b) => b.occurrences - a.occurrences || a.id.localeCompare(b.id),
  );
  const events: Array<
    | { kind: 'review'; entry: ReviewHistoryEntry }
    | { kind: 'fix'; entry: ReviewFixCoverageEntry }
  > = [
    ...history.reviews.map((entry) => ({ kind: 'review' as const, entry })),
    ...history.fixes.map((entry) => ({ kind: 'fix' as const, entry })),
  ].sort(
    (a, b) =>
      a.entry.endedAt.localeCompare(b.entry.endedAt) ||
      a.entry.artifactPath.localeCompare(b.entry.artifactPath),
  );
  const omittedCount = Math.max(0, events.length - MAX_DETAILED_HISTORY_EVENTS);
  const recentEvents = events.slice(-MAX_DETAILED_HISTORY_EVENTS);
  const lines = [
    '## Prior review/fix history',
    '',
    'This history spans earlier fresh sessions and runs. Treat it as a convergence ledger, not as proof that a prior fix was complete.',
    '',
  ];

  if (familyOccurrences.length > 0) {
    lines.push(
      '### Family occurrence totals',
      ...familyOccurrences.map(
        (family) =>
          `- \`${family.id}\`: ${family.occurrences} review(s) — ${family.invariant}`,
      ),
      '',
    );
  }
  if (omittedCount > 0) {
    lines.push(
      `${omittedCount} older event(s) omitted from detailed history; the family totals above still include them.`,
      '',
    );
  }

  for (const event of recentEvents) {
    if (event.kind === 'review') {
      const review = event.entry;
      lines.push(`### Review ${review.round} — ${review.summary}`);
      if (review.findingFamilies.length === 0) {
        lines.push('- Finding families: not reported (legacy or malformed review output).');
      } else {
        lines.push(
          ...review.findingFamilies.map(
            (family) => `- \`${family.id}\`: ${family.invariant}`,
          ),
        );
      }
    } else {
      const fix = event.entry;
      lines.push(`### Fix ${fix.round} coverage`);
      if (fix.body) {
        const body =
          fix.body.length <= MAX_FIX_COVERAGE_CHARS
            ? fix.body
            : `${fix.body.slice(0, MAX_FIX_COVERAGE_CHARS)}\n…(coverage report truncated)`;
        lines.push(...body.split('\n'));
      } else {
        lines.push('- No structured coverage report was supplied.');
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/** The four dimensions a fix row must account for, in the order the prompt teaches. */
const FIX_COVERAGE_FIELDS = ['invariant', 'central fix', 'sibling cases audited', 'tests'] as const;

/** `- \`family-id\` — <fields>` — the row opener; the rest is parsed by label. */
const FIX_COVERAGE_ROW = /^\s*-\s+`([a-z0-9]+(?:-[a-z0-9]+)*)`\s+[—–-]\s+(.+)$/i;

/**
 * Whether one row accounts for all four dimensions, anchored on the *labels*
 * rather than on the punctuation between them.
 *
 * The delimiter is not the contract. A real fix row runs to several sentences
 * per field and often carries semicolons inside a field, at which point joining
 * the fields with semicolons too is ambiguous and a session reasonably reaches
 * for full stops instead. Demanding `;` there rejected complete, accurate
 * reports — and rejection is expensive: it discards a finished fix pass and
 * escalates to a human. What must actually hold is that each label is present,
 * in order, with something under it.
 */
function coversEveryField(text: string): boolean {
  const haystack = text.toLowerCase();
  const starts: number[] = [];
  let cursor = 0;
  for (const field of FIX_COVERAGE_FIELDS) {
    const at = haystack.indexOf(`${field}:`, cursor);
    if (at === -1) return false;
    starts.push(at);
    cursor = at + field.length + 1;
  }
  return starts.every((start, index) => {
    const from = start + FIX_COVERAGE_FIELDS[index]!.length + 1;
    const to = starts[index + 1] ?? text.length;
    // Trailing separator punctuation belongs to the join, not to the content.
    return text.slice(from, to).replace(/[\s.;,—–-]+$/, '').trim() !== '';
  });
}

/**
 * A fix report is complete only when every family from the blocking review has
 * a structured row covering its invariant, central fix, sibling-case audit,
 * and tests. Extra family ids are harmless; the next review independently
 * checks whether the claimed coverage is real.
 */
export function missingFixCoverageFamilies(
  coverage: ReviewFixCoverageEntry,
  expectedFamilies: ReviewFindingFamily[],
): string[] {
  if (expectedFamilies.length === 0) return [];
  const completeIds = new Set<string>();
  for (const line of (coverage.body ?? '').split('\n')) {
    const row = line.match(FIX_COVERAGE_ROW);
    if (row?.[1] && coversEveryField(row[2]!)) completeIds.add(row[1]);
  }
  return [
    ...new Set(
      expectedFamilies
        .map((family) => family.id)
        .filter((id) => !completeIds.has(id)),
    ),
  ];
}

function extractSectionBody(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\s*\\n([\\s\\S]*?)(?:\\n## |$)`, 'i'));
  return match ? (match[1] ?? '').trim() || null : null;
}

export function writeFixCoverageArtifact(
  artifactPath: string,
  options: { issueId: string; round: number; agentText: string },
): ReviewFixCoverageEntry {
  const entry: ReviewFixCoverageEntry = {
    issueId: options.issueId,
    round: options.round,
    endedAt: new Date().toISOString(),
    body: extractSectionBody(options.agentText.trim(), LOOP_FIX_COVERAGE_HEADING),
    artifactPath,
  };
  writeFileSync(artifactPath, `${JSON.stringify(entry, null, 2)}\n`);
  return entry;
}
