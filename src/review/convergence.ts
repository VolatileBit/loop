
import type { ReviewSeverity } from './verdict.js';

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
