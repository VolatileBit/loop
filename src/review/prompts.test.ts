import { describe, expect, it } from 'vitest';

import { makeIssue } from '../issues/test-helpers.js';
import type { ReviewConvergenceHistory } from './convergence.js';
import { buildDistillPrompt, buildFixNitsPrompt, buildImplementPrompt, buildReviewPrompt } from './prompts.js';

const POLYWEAVE_CONTEXT = {
  reviewSkill: '/review-work',
  tddSkill: '/tdd',
  labels: { inProgress: 'in-progress', done: 'agent-done' },
};

const RECURRING_REVIEW_HISTORY: ReviewConvergenceHistory = {
  reviews: [
    {
      issueId: 'PRD-002/issue-10',
      round: 1,
      endedAt: '2026-07-26T10:00:00.000Z',
      summary: 'Direct installs omit the CLI entry point.',
      severity: 'blocking',
      findingFamilies: [
        {
          id: 'cli-packaging',
          invariant: 'Every documented install mode exposes a runnable CLI.',
        },
      ],
      artifactPath: '.loop/runs/PRD-002/run-a/reviews/round-1/review.json',
    },
    {
      issueId: 'PRD-002/issue-10',
      round: 2,
      endedAt: '2026-07-26T11:00:00.000Z',
      summary: 'The built entry point is still absent from the package.',
      severity: 'blocking',
      findingFamilies: [
        {
          id: 'cli-packaging',
          invariant: 'Every documented install mode exposes a runnable CLI.',
        },
      ],
      artifactPath: '.loop/runs/PRD-002/run-a/reviews/round-2/review.json',
    },
  ],
  fixes: [
    {
      issueId: 'PRD-002/issue-10',
      round: 1,
      endedAt: '2026-07-26T10:30:00.000Z',
      body: '- `cli-packaging` — added a source-level bin mapping and one direct execution test.',
      artifactPath: '.loop/runs/PRD-002/run-a/fix-1.coverage.json',
    },
  ],
};

describe('buildReviewPrompt', () => {
  it('is review-only and requires the Loop verdict block', () => {
    const prompt = buildReviewPrompt(
      makeIssue({ id: 'issue-10', project: 'PRD-002' }),
      { fixedPoint: 'main' },
      POLYWEAVE_CONTEXT,
    );
    expect(prompt).toContain('Run /review-work');
    expect(prompt).toContain('review-only');
    expect(prompt).toContain('## Loop verdict');
    expect(prompt).toContain('Do not implement code changes');
  });

  it('formats commit SHA fixed points for git diff', () => {
    const prompt = buildReviewPrompt(
      makeIssue({ id: 'issue-10', project: 'PRD-002' }),
      { fixedPoint: 'abc1234' },
      POLYWEAVE_CONTEXT,
    );
    expect(prompt).toContain('git diff abc1234...HEAD');
    expect(prompt).toContain('(PRD-002/issue-10)');
    expect(prompt).toContain('empty diff is normal');
  });

  it('omits the skill directive and reviews against the spec directly when reviewSkill is unset', () => {
    const prompt = buildReviewPrompt(makeIssue({ id: 'issue-10' }), { fixedPoint: 'main' }, {});
    expect(prompt).not.toContain('/review-work');
    expect(prompt).toContain('against the issue spec');
    expect(prompt).toContain('## Loop verdict');
  });

  it('adds the feature-context line when a spec path is given', () => {
    const prompt = buildReviewPrompt(
      makeIssue({ id: 'issue-10' }),
      { fixedPoint: 'main' },
      { specRelPath: 'docs/specs/PRD-001-feature.md' },
    );
    expect(prompt).toContain('Feature context: read `docs/specs/PRD-001-feature.md`');
  });

  it('mentions the review round after round 1', () => {
    const prompt = buildReviewPrompt(
      makeIssue({ id: 'issue-10' }),
      { round: 2, fixedPoint: 'main' },
      POLYWEAVE_CONTEXT,
    );
    expect(prompt).toContain('(review round 2)');
  });

  it('carries prior family and fix history into later reviews', () => {
    const prompt = buildReviewPrompt(
      makeIssue({ id: 'issue-10', project: 'PRD-002' }),
      { round: 3, fixedPoint: 'main', history: RECURRING_REVIEW_HISTORY },
      POLYWEAVE_CONTEXT,
    );

    expect(prompt).toContain('Prior review/fix history');
    expect(prompt).toContain('`cli-packaging`');
    expect(prompt).toContain('added a source-level bin mapping');
    expect(prompt).toContain('Do not drip-feed');
    expect(prompt).toContain('reuse its exact family id');
    expect(prompt).toContain('## Loop finding families');
  });

  it('embeds the bundled two-axis workflow when reviewSkill is "builtin"', () => {
    const prompt = buildReviewPrompt(
      makeIssue({ id: 'issue-10' }),
      { fixedPoint: 'abc1234' },
      { reviewSkill: 'builtin' },
    );
    expect(prompt).toContain('## How to review');
    expect(prompt).toContain('Smell baseline');
    expect(prompt).toContain('git diff abc1234...HEAD');
    expect(prompt).not.toContain('Run builtin');
    expect(prompt).toContain('## Loop verdict');
  });
});

describe('buildImplementPrompt', () => {
  it('uses implement-only prompt without inline review-work', () => {
    const prompt = buildImplementPrompt(makeIssue({ id: 'issue-01' }), {}, POLYWEAVE_CONTEXT);
    expect(prompt).toContain('Use /tdd where possible');
    expect(prompt).toContain('Do not run /review-work in this session');
    expect(prompt).toContain('triage: in-progress');
    expect(prompt).not.toContain('triage: agent-done');
  });

  it('omits skill directives when unset', () => {
    const prompt = buildImplementPrompt(makeIssue({ id: 'issue-01' }), {}, {});
    expect(prompt).not.toContain('/tdd');
    expect(prompt).not.toContain('/review-work');
    expect(prompt).toContain('Do not run a review pass in this session');
  });

  it('adds the feature-context line when a spec path is given', () => {
    const prompt = buildImplementPrompt(
      makeIssue({ id: 'issue-01' }),
      {},
      { specRelPath: 'docs/specs/PRD-001-feature.md' },
    );
    expect(prompt).toContain('Feature context: read `docs/specs/PRD-001-feature.md`');
  });

  it('includes review feedback when fixing blocking findings', () => {
    const prompt = buildImplementPrompt(
      makeIssue({ id: 'issue-10', project: 'PRD-002' }),
      {
        reviewFeedback: {
          round: 1,
          body: '## Spec\nMissing wrong-role event.',
        },
      },
      POLYWEAVE_CONTEXT,
    );
    expect(prompt).toContain('Review feedback (fix round 1)');
    expect(prompt).toContain('Missing wrong-role event');
    expect(prompt).toContain('Do not run /review-work in this session');
    expect(prompt).toContain('fix: review fix 1 (PRD-002/issue-10)');
    expect(prompt).toContain('state the invariant');
    expect(prompt).toContain('sibling paths');
    expect(prompt).toContain('## Loop fix coverage');
  });

  it('switches recurring families into deep-fix mode with cumulative history', () => {
    const prompt = buildImplementPrompt(
      makeIssue({ id: 'issue-10', project: 'PRD-002' }),
      {
        reviewFeedback: {
          round: 2,
          body: 'The packaged CLI is still missing.',
          history: RECURRING_REVIEW_HISTORY,
        },
      },
      POLYWEAVE_CONTEXT,
    );

    expect(prompt).toContain('Deep-fix mode');
    expect(prompt).toContain('`cli-packaging` has recurred across 2 reviews');
    expect(prompt).toContain('added a source-level bin mapping');
    expect(prompt).toContain('exact examples are not the boundary');
  });

  it('includes verify output when fixing verification failures', () => {
    const prompt = buildImplementPrompt(
      makeIssue({ id: 'issue-10', project: 'PRD-002' }),
      {
        verifyFeedback: {
          round: 1,
          cmd: 'pnpm typecheck && pnpm test:unit',
          output: 'FAIL  packages/foo/src/a.test.ts > does the thing',
          failures: ['FAIL  packages/foo/src/a.test.ts > does the thing'],
        },
      },
      POLYWEAVE_CONTEXT,
    );
    expect(prompt).toContain('Verification failure (fix round 1)');
    expect(prompt).toContain('pnpm typecheck && pnpm test:unit');
    expect(prompt).toContain('FAIL  packages/foo/src/a.test.ts');
    expect(prompt).toContain('Failure summary');
    expect(prompt).toContain('fix: verify fix 1 (PRD-002/issue-10)');
  });

  it('requires a git commit with the implement label', () => {
    const prompt = buildImplementPrompt(makeIssue({ id: 'issue-01' }), {}, POLYWEAVE_CONTEXT);
    expect(prompt).toContain('Git (only when you change files):');
    expect(prompt).toContain('no commit required');
    expect(prompt).toContain('feat: implement (PRD-001/issue-01)');
    expect(prompt).toContain('Do **not** add filler edits');
    expect(prompt).toContain('## Loop commit');
    expect(prompt).toContain('## Loop handoff');
    expect(prompt).not.toContain('Do not commit');
    expect(prompt).not.toContain('Git (required):');
  });

  it('includes a prior handoff note when provided', () => {
    const prompt = buildImplementPrompt(
      makeIssue({ id: 'issue-01' }),
      { handoff: 'Config resolution is done; adapter wiring remains.' },
      POLYWEAVE_CONTEXT,
    );
    expect(prompt).toContain('Handoff from previous stage');
    expect(prompt).toContain('Config resolution is done; adapter wiring remains.');
  });

  it('places current review feedback before a historical handoff and makes Git authoritative', () => {
    const prompt = buildImplementPrompt(
      makeIssue({ id: 'issue-01' }),
      {
        handoff: 'Changes remain unstaged; create the fallback commit externally.',
        reviewFeedback: {
          round: 2,
          body: 'The newly reviewed tree still mishandles computed exports.',
        },
      },
      POLYWEAVE_CONTEXT,
    );

    expect(prompt.indexOf('## Review feedback (fix round 2)')).toBeLessThan(
      prompt.indexOf('## Historical handoff from the previous stage'),
    );
    expect(prompt).toContain(
      'Current review feedback and the Git working tree are authoritative.',
    );
    expect(prompt).toContain(
      'may describe worktree state from before Loop created its fallback commit',
    );
  });

  it('embeds the bundled TDD workflow when tddSkill is "builtin"', () => {
    const prompt = buildImplementPrompt(makeIssue({ id: 'issue-01' }), {}, { tddSkill: 'builtin' });
    expect(prompt).toContain('## How to work: test-driven development');
    expect(prompt).toContain('Red before green');
    expect(prompt).not.toContain('Use builtin where possible');
  });

  it('states the in-session-proof deal when the verify command is known', () => {
    const context = { ...POLYWEAVE_CONTEXT, verifyCmd: 'pnpm verify' };
    const implement = buildImplementPrompt(makeIssue({ id: 'issue-01' }), {}, context);
    expect(implement).toContain('run `pnpm verify` **exactly as written**');
    expect(implement).toContain('a pipe masks the exit code');
    expect(implement).toContain('skips its duplicate verify run');

    // The verify-fix deal quotes the failing command itself.
    const verifyFix = buildImplementPrompt(
      makeIssue({ id: 'issue-01' }),
      { verifyFeedback: { round: 1, cmd: 'pnpm verify', output: 'FAIL', failures: [] } },
      {},
    );
    expect(verifyFix).toContain('Confirm the fix by re-running the command yourself.');
    expect(verifyFix).toContain('run `pnpm verify` **exactly as written**');

    const reviewFix = buildImplementPrompt(
      makeIssue({ id: 'issue-01' }),
      { reviewFeedback: { round: 1, body: 'findings' } },
      context,
    );
    expect(reviewFix).toContain('Confirm the fix passes verification.');

    // Without a known verify command the deal is omitted entirely.
    const bare = buildImplementPrompt(makeIssue({ id: 'issue-01' }), {}, {});
    expect(bare).not.toContain('exactly as written');
  });
});

describe('buildDistillPrompt', () => {
  it('targets the notes and archives, demands verified promotion, and states the deal', () => {
    const prompt = buildDistillPrompt({
      project: 'PRD-006',
      notesPath: '/repo/.loop/notes/PRD-006.md',
      runArchiveDir: '/repo/.loop/runs/PRD-006',
      verifyCmd: 'pnpm verify',
    });
    expect(prompt).toContain('`/repo/.loop/notes/PRD-006.md`');
    expect(prompt).toContain('/repo/.loop/runs/PRD-006/*/handoff.md');
    expect(prompt).toContain('CONTEXT.md');
    expect(prompt).toContain('Verify each claim against the code');
    expect(prompt).toContain('run `pnpm verify` **exactly as written**');
    expect(prompt).toContain('rewrite the notes file itself');
  });
});

describe('buildFixNitsPrompt', () => {
  it('targets the backlog file, states the deal, and requires the decisions block', () => {
    const prompt = buildFixNitsPrompt({ nitsPath: '/repo/.loop/nits.md', verifyCmd: 'pnpm verify' });
    expect(prompt).toContain('`/repo/.loop/nits.md`');
    expect(prompt).toContain('fix** it');
    expect(prompt).toContain('dismiss');
    expect(prompt).toContain('run `pnpm verify` **exactly as written**');
    expect(prompt).toContain('## Loop nits decisions');
  });
});

describe('shared project notes in prompts', () => {
  const NOTES = '/repo/.loop/notes/PRD-006.md';

  it('implement prompts read the notes and (only when not a fix pass) update them', () => {
    const implement = buildImplementPrompt(makeIssue({ id: 'issue-01' }), {}, { projectNotesPath: NOTES });
    expect(implement).toContain(`shared project notes at \`${NOTES}\``);
    expect(implement).toContain('Update the shared project notes');

    const verifyFix = buildImplementPrompt(
      makeIssue({ id: 'issue-01' }),
      { verifyFeedback: { cmd: 'pnpm verify', output: 'boom', round: 1, failures: [] } },
      { projectNotesPath: NOTES },
    );
    expect(verifyFix).toContain(`shared project notes at \`${NOTES}\``);
    expect(verifyFix).not.toContain('Update the shared project notes');

    const without = buildImplementPrompt(makeIssue({ id: 'issue-01' }), {}, {});
    // Generic handoff guidance is bundled, but no read/write target is invented.
    expect(without).not.toContain('Also read the shared project notes');
    expect(without).not.toContain('Update the shared project notes');
    expect(without).not.toContain(NOTES);
  });

  it('review prompts read the notes and allow correcting them as the read-only exception', () => {
    const review = buildReviewPrompt(makeIssue({ id: 'issue-01' }), {}, { projectNotesPath: NOTES });
    expect(review).toContain(`\`${NOTES}\``);
    expect(review).toContain('one exception');
    expect(buildReviewPrompt(makeIssue({ id: 'issue-01' }), {}, {})).not.toContain('Shared project notes');
  });
});
