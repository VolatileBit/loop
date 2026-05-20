import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDirs, makeTempRoot } from '../issues/test-helpers.js';
import {
  describeConvergenceFailure,
  formatReviewConvergenceHistory,
  loadReviewConvergenceHistory,
  missingFixCoverageFamilies,
  summarizeReviewConvergence,
  writeFixCoverageArtifact,
  type ReviewConvergenceHistory,
} from './convergence.js';

afterEach(cleanupTempDirs);

const HISTORY: ReviewConvergenceHistory = {
  reviews: [
    {
      issueId: 'PRD-011/issue-02',
      round: 1,
      endedAt: '2026-07-26T10:00:00.000Z',
      summary: 'Direct CLI installs do not expose the executable.',
      severity: 'blocking',
      findingFamilies: [
        {
          id: 'cli-packaging',
          invariant: 'Every documented install mode exposes a runnable CLI.',
        },
      ],
      artifactPath: '.loop/runs/PRD-011/run-a/reviews/round-1/review.json',
    },
    {
      issueId: 'PRD-011/issue-02',
      round: 2,
      endedAt: '2026-07-26T11:00:00.000Z',
      summary: 'The package still omits the built entry point.',
      severity: 'blocking',
      findingFamilies: [
        {
          id: 'cli-packaging',
          invariant: 'Every documented install mode exposes a runnable CLI.',
        },
        {
          id: 'manifest-validation',
          invariant: 'Manifest validation reports every independent contract violation.',
        },
      ],
      artifactPath: '.loop/runs/PRD-011/run-a/reviews/round-2/review.json',
    },
  ],
  fixes: [],
};

describe('review convergence history', () => {
  it('groups recurring findings by stable family id', () => {
    const summary = summarizeReviewConvergence(HISTORY);

    expect(summary.reviewCount).toBe(2);
    expect(summary.recurringFamilies).toEqual([
      {
        id: 'cli-packaging',
        invariant: 'Every documented install mode exposes a runnable CLI.',
        occurrences: 2,
        rounds: [1, 2],
      },
    ]);
    expect(describeConvergenceFailure(summary, 2)).toContain('`cli-packaging` (2 reviews)');
  });

  it('counts a family at most once per review', () => {
    const summary = summarizeReviewConvergence({
      reviews: [
        {
          ...HISTORY.reviews[0]!,
          findingFamilies: [
            {
              id: 'cli-packaging',
              invariant: 'Every documented install mode exposes a runnable CLI.',
            },
            {
              id: 'cli-packaging',
              invariant: 'Every documented install mode exposes a runnable CLI.',
            },
          ],
        },
      ],
      fixes: [],
    });

    expect(summary.recurringFamilies).toEqual([]);
  });

  it('does not keep a historically recurring family active after the latest review resolves it', () => {
    const summary = summarizeReviewConvergence({
      reviews: [
        HISTORY.reviews[0]!,
        {
          ...HISTORY.reviews[1]!,
          findingFamilies: [HISTORY.reviews[0]!.findingFamilies[0]!],
        },
        {
          ...HISTORY.reviews[1]!,
          round: 3,
          endedAt: '2026-07-26T12:00:00.000Z',
          summary: 'Only manifest validation remains.',
          findingFamilies: [
            {
              id: 'manifest-validation',
              invariant: 'Manifest validation reports every independent contract violation.',
            },
          ],
        },
      ],
      fixes: [],
    });

    expect(summary.recurringFamilies).toEqual([]);
    expect(summary.latestFamilies.map((family) => family.id)).toEqual(['manifest-validation']);
  });

  it('bounds detailed prompt history while retaining aggregate family counts', () => {
    const reviews = Array.from({ length: 14 }, (_, index) => ({
      ...HISTORY.reviews[0]!,
      round: index + 1,
      endedAt: `2026-07-26T${String(index).padStart(2, '0')}:00:00.000Z`,
      summary: `Review summary ${index + 1}`,
    }));

    const formatted = formatReviewConvergenceHistory({ reviews, fixes: [] });

    expect(formatted).toContain('`cli-packaging`: 14 review(s)');
    expect(formatted).toContain('2 older event(s) omitted');
    expect(formatted).not.toContain('Review 1 — Review summary 1');
    expect(formatted).toContain('Review 14 — Review summary 14');
  });

  it('loads prior review and fix coverage artifacts for only the requested issue', () => {
    const root = makeTempRoot();
    const reviewDir = path.join(root, '.loop/runs/PRD-011/run-a/reviews/round-1');
    const otherDir = path.join(root, '.loop/runs/PRD-011/run-b/reviews/round-1');
    const failedDir = path.join(root, '.loop/runs/PRD-011/run-c/reviews/round-1');
    mkdirSync(reviewDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    mkdirSync(failedDir, { recursive: true });
    writeFileSync(
      path.join(reviewDir, 'review.json'),
      JSON.stringify({
        issueId: 'PRD-011/issue-02',
        round: 1,
        endedAt: '2026-07-26T10:00:00.000Z',
        summary: 'CLI package is incomplete.',
        severity: 'blocking',
        findingFamilies: [
          {
            id: 'cli-packaging',
            invariant: 'Every documented install mode exposes a runnable CLI.',
          },
        ],
      }),
    );
    writeFileSync(
      path.join(reviewDir, 'fix-1.coverage.json'),
      JSON.stringify({
        issueId: 'PRD-011/issue-02',
        round: 1,
        endedAt: '2026-07-26T10:30:00.000Z',
        body: '- `cli-packaging` — changed bin publication and tested local install.',
      }),
    );
    writeFileSync(
      path.join(otherDir, 'review.json'),
      JSON.stringify({
        issueId: 'PRD-011/issue-03',
        round: 1,
        endedAt: '2026-07-26T09:00:00.000Z',
        summary: 'Unrelated.',
        severity: 'blocking',
        findingFamilies: [],
      }),
    );
    writeFileSync(
      path.join(failedDir, 'review.json'),
      JSON.stringify({
        issueId: 'PRD-011/issue-02',
        round: 2,
        endedAt: '2026-07-26T11:00:00.000Z',
        completed: false,
        summary: 'Partial output before a usage limit.',
        severity: 'blocking',
        findingFamilies: [
          {
            id: 'partial-output',
            invariant: 'This must not enter convergence history.',
          },
        ],
      }),
    );

    const history = loadReviewConvergenceHistory(root, {
      project: 'PRD-011',
      qualifiedId: 'PRD-011/issue-02',
    });

    expect(history.reviews).toHaveLength(1);
    expect(history.reviews[0]?.summary).toBe('CLI package is incomplete.');
    expect(history.fixes).toHaveLength(1);
    expect(history.fixes[0]?.body).toContain('changed bin publication');
  });

  it('persists the structured fix coverage block and records an omitted report', () => {
    const root = makeTempRoot();
    const artifactPath = path.join(root, 'fix-1.coverage.json');

    const reported = writeFixCoverageArtifact(artifactPath, {
      issueId: 'PRD-011/issue-02',
      round: 1,
      agentText: [
        'Done.',
        '',
        '## Loop fix coverage',
        '- `cli-packaging` — changed the package publication seam and tested both install modes.',
        '',
        '## Loop handoff',
        'Ready for review.',
      ].join('\n'),
    });

    expect(reported.body).toContain('tested both install modes');
    expect(JSON.parse(readFileSync(artifactPath, 'utf8')).body).toBe(reported.body);

    const omitted = writeFixCoverageArtifact(artifactPath, {
      issueId: 'PRD-011/issue-02',
      round: 2,
      agentText: 'Fixed it without the requested report.',
    });
    expect(omitted.body).toBeNull();
  });

  it('requires every fix coverage field for each current finding family', () => {
    const expectedFamilies = HISTORY.reviews[1]!.findingFamilies;
    const coverage = {
      issueId: 'PRD-011/issue-02',
      round: 2,
      endedAt: '2026-07-26T11:30:00.000Z',
      body: [
        '- `cli-packaging`',
        '- `manifest-validation` — invariant: all violations are reported; central fix: shared validator; sibling cases audited: invalid names and paths; tests: validator integration tests',
      ].join('\n'),
      artifactPath: '.loop/runs/PRD-011/run-a/fix-2.coverage.json',
    };

    expect(missingFixCoverageFamilies(coverage, expectedFamilies)).toEqual([
      'cli-packaging',
    ]);
  });

  it('accepts fields joined by full stops, not only semicolons', () => {
    // Shape taken from a real run (PRD-011/issue-03, 2026-08-05). Each field ran
    // to several sentences and the invariant carried its own semicolons, so the
    // session joined the fields with full stops — and a semicolon-only parser
    // discarded a correct, committed, verified fix pass over the delimiter.
    const coverage = {
      issueId: 'PRD-011/issue-03',
      round: 1,
      endedAt: '2026-08-05T02:57:00.516Z',
      body:
        '- `reported-contrast-theme-scope` — invariant: a shortfall suppresses the ' +
        'diagnostic only in the theme that measures short; every theme absent from the ' +
        'acknowledgement is enforced. Central fix: `status` replaced by `reported?: ' +
        'Theme[]`, consumed by the per-theme loop in `compiler.ts`. Sibling cases ' +
        'audited: shortfall in an unacknowledged theme; malformed acknowledgements. ' +
        'Tests: 7 in `palette.test.ts`, all verified red beforehand.',
      artifactPath: '.loop/runs/PRD-011/run-c/fix-1.coverage.json',
    };

    expect(
      missingFixCoverageFamilies(coverage, [
        { id: 'reported-contrast-theme-scope', invariant: 'theme-scoped acknowledgement' },
      ]),
    ).toEqual([]);
  });

  it('still reports a family whose row leaves a field empty', () => {
    const coverage = {
      issueId: 'PRD-011/issue-03',
      round: 1,
      endedAt: '2026-08-05T02:57:00.516Z',
      // Loosening the delimiter must not loosen what has to be said: `tests:`
      // is present but has nothing under it.
      body:
        '- `theme-scope` — invariant: holds everywhere. Central fix: one seam. ' +
        'Sibling cases audited: both themes. Tests:',
      artifactPath: '.loop/runs/PRD-011/run-c/fix-1.coverage.json',
    };

    expect(
      missingFixCoverageFamilies(coverage, [{ id: 'theme-scope', invariant: 'x' }]),
    ).toEqual(['theme-scope']);
  });

  it('still reports a family whose row omits a field entirely', () => {
    const coverage = {
      issueId: 'PRD-011/issue-03',
      round: 1,
      endedAt: '2026-08-05T02:57:00.516Z',
      body: '- `theme-scope` — invariant: holds. Central fix: one seam. Tests: 7 added.',
      artifactPath: '.loop/runs/PRD-011/run-c/fix-1.coverage.json',
    };

    expect(
      missingFixCoverageFamilies(coverage, [{ id: 'theme-scope', invariant: 'x' }]),
    ).toEqual(['theme-scope']);
  });

  it('accepts complete structured coverage for every current finding family', () => {
    const expectedFamilies = HISTORY.reviews[1]!.findingFamilies;
    const coverage = {
      issueId: 'PRD-011/issue-02',
      round: 2,
      endedAt: '2026-07-26T11:30:00.000Z',
      body: [
        '- `cli-packaging` — invariant: every install runs; central fix: package publication; sibling cases audited: global and local installs; tests: packaged CLI smoke tests',
        '- `manifest-validation` — invariant: all violations are reported; central fix: shared validator; sibling cases audited: invalid names and paths; tests: validator integration tests',
      ].join('\n'),
      artifactPath: '.loop/runs/PRD-011/run-a/fix-2.coverage.json',
    };

    expect(missingFixCoverageFamilies(coverage, expectedFamilies)).toEqual([]);
  });

  it('rejects a coverage row with an empty required field', () => {
    const expectedFamilies = [HISTORY.reviews[0]!.findingFamilies[0]!];
    const coverage = {
      issueId: 'PRD-011/issue-02',
      round: 2,
      endedAt: '2026-07-26T11:30:00.000Z',
      body: '- `cli-packaging` — invariant: every install runs; central fix: ; sibling cases audited: global and local installs; tests: packaged CLI smoke tests',
      artifactPath: '.loop/runs/PRD-011/run-a/fix-2.coverage.json',
    };

    expect(missingFixCoverageFamilies(coverage, expectedFamilies)).toEqual([
      'cli-packaging',
    ]);
  });
});
