import { describe, expect, it } from 'vitest';

import {
  isReviewSatisfied,
  parseReviewVerdict,
  reviewFixAttemptsExhausted,
  reviewRequiresFix,
  reviewVerdictContractError,
  shouldRunImplementFixAfterBlockingReview,
  verifyFixAttemptsExhausted,
} from './verdict.js';

describe('parseReviewVerdict', () => {
  it('parses explicit Loop verdict block', () => {
    const verdict = parseReviewVerdict(`
## Standards
All good.

## Spec
Missing event for wrong-role.

## Loop verdict
changes-requested: yes
severity: blocking
summary: Wrong-role rejections are not recorded.

## Loop finding families
- \`role-rejection-audit\`: Every rejected role transition records the same audit event.
- \`transition-errors\`: Transition failures preserve the public error contract.
`);
    expect(verdict.changesRequested).toBe(true);
    expect(verdict.severity).toBe('blocking');
    expect(verdict.summary).toContain('Wrong-role');
    expect(verdict.findingFamilies).toEqual([
      {
        id: 'role-rejection-audit',
        invariant: 'Every rejected role transition records the same audit event.',
      },
      {
        id: 'transition-errors',
        invariant: 'Transition failures preserve the public error contract.',
      },
    ]);
    expect(reviewRequiresFix(verdict)).toBe(true);
    expect(isReviewSatisfied(verdict)).toBe(false);
  });

  it('treats nits-only as satisfied', () => {
    const verdict = parseReviewVerdict(`
## Loop verdict
changes-requested: yes
severity: nits-only
summary: Minor naming suggestions only.
`);
    expect(isReviewSatisfied(verdict)).toBe(true);
    expect(reviewRequiresFix(verdict)).toBe(false);
  });

  it('ignores malformed family lines and the explicit none sentinel', () => {
    const verdict = parseReviewVerdict(`
## Loop verdict
changes-requested: no
severity: none
summary: ready

## Loop finding families
- none
- missing-backticks: not a valid family entry
`);

    expect(verdict.findingFamilies).toEqual([]);
  });

  it('infers a pass from body text when the verdict block is missing', () => {
    const verdict = parseReviewVerdict('Everything looks good, ready to ship.');
    expect(verdict.changesRequested).toBe(false);
    expect(isReviewSatisfied(verdict)).toBe(true);
  });

  it('defaults to changes-requested for an empty/uninformative body', () => {
    const verdict = parseReviewVerdict('Some inconclusive text.');
    expect(verdict.changesRequested).toBe(true);
  });

  it('rejects a blocking verdict without structured finding families', () => {
    const verdict = parseReviewVerdict(`
## Loop verdict
changes-requested: yes
severity: blocking
summary: Packaging remains incomplete.
`);

    expect(reviewVerdictContractError(verdict)).toContain(
      'blocking review must report at least one structured finding family',
    );
  });

  it('does not require finding families for a satisfied verdict', () => {
    const verdict = parseReviewVerdict(`
## Loop verdict
changes-requested: no
severity: none
summary: Ready.

## Loop finding families
- none
`);

    expect(reviewVerdictContractError(verdict)).toBeNull();
  });
});

describe('review fix cycle limits', () => {
  it('allows up to maxCycles implement fixes after blocking reviews', () => {
    expect(reviewFixAttemptsExhausted(0, 3)).toBe(false);
    expect(reviewFixAttemptsExhausted(2, 3)).toBe(false);
    expect(reviewFixAttemptsExhausted(3, 3)).toBe(true);
  });

  it('shouldRunImplementFixAfterBlockingReview mirrors exhaustion', () => {
    expect(shouldRunImplementFixAfterBlockingReview(0, 3)).toBe(true);
    expect(shouldRunImplementFixAfterBlockingReview(2, 3)).toBe(true);
    expect(shouldRunImplementFixAfterBlockingReview(3, 3)).toBe(false);
  });
});

describe('verify fix cycle limits', () => {
  it('allows up to maxCycles verify fix passes', () => {
    expect(verifyFixAttemptsExhausted(0, 3)).toBe(false);
    expect(verifyFixAttemptsExhausted(2, 3)).toBe(false);
    expect(verifyFixAttemptsExhausted(3, 3)).toBe(true);
  });
});
