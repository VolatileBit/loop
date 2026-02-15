import { describe, expect, it } from 'vitest';

import { isSharedUsageLimitError, parseUsageLimitDetails } from './usage-limit.js';

describe('isSharedUsageLimitError', () => {
  const matches = [
    "You've hit your usage limit",
    // Observed live from claude-code on 2026-08-04. The window keeps getting
    // renamed — "usage", then "5-hour", now "session" — so the pattern must not
    // depend on which word lands there.
    "You've hit your session limit \u00b7 resets 1:20am (Australia/Brisbane)",
    "You've hit your weekly limit",
    "You've hit your 5-hour limit",
    "You've reached your limit",
    'session limit reached',
    'weekly limit exceeded',
    'usage limit reached',
    'usage limits exceeded',
    'usage_limit_reached',
    'rate limit exceeded',
    'rate_limit_exceeded',
    'rate_limit_error',
    'quota exceeded',
    'too many requests',
    'resource_exhausted',
    'out of requests',
    'HTTP 429',
    '"status": 429',
    '"code": 429',
    'statusCode: 429',
  ];

  const nonMatches = [
    // The loose "hit your … limit" branch still needs a limit to be hit.
    'you can raise your limit in settings',
    'the diff hit your test coverage threshold',
    'executionTime: 742934ms',
    'elapsed 429ms',
    'timestamp 1742934000',
    'all tests passed',
    'status: ok',
    'code: 200',
  ];

  it.each(matches)('matches quota phrasing: %s', (text) => {
    expect(isSharedUsageLimitError(text)).toBe(true);
  });

  it.each(nonMatches)('does not match benign text: %s', (text) => {
    expect(isSharedUsageLimitError(text)).toBe(false);
  });
});

describe('parseUsageLimitDetails', () => {
  const NOW = Date.parse('2026-07-18T12:00:00Z');

  it('classifies weekly-window phrasings; everything else is session', () => {
    expect(parseUsageLimitDetails('weekly usage limit reached', NOW).scope).toBe('weekly');
    expect(parseUsageLimitDetails('7-day limit exceeded', NOW).scope).toBe('weekly');
    expect(parseUsageLimitDetails('usage limit reached', NOW).scope).toBe('session');
  });

  it('reads structured resetsAt fields, in seconds or milliseconds', () => {
    expect(parseUsageLimitDetails('{"resetsAt": 1786000000}', NOW).resetsAtMs).toBe(1786000000000);
    expect(parseUsageLimitDetails('{"resets_at":"1786000000000"}', NOW).resetsAtMs).toBe(1786000000000);
  });

  it('reads the piped-epoch claude phrasing', () => {
    expect(parseUsageLimitDetails('Claude AI usage limit reached|1786000000', NOW).resetsAtMs).toBe(
      1786000000000,
    );
  });

  it('reads ISO timestamps near a reset phrase', () => {
    const details = parseUsageLimitDetails('rate limited; retry after 2026-07-18T14:30:00Z', NOW);
    expect(details.resetsAtMs).toBe(Date.parse('2026-07-18T14:30:00Z'));
  });

  it('reads relative durations', () => {
    expect(parseUsageLimitDetails('try again in 2 hours', NOW).resetsAtMs).toBe(NOW + 2 * 3_600_000);
    expect(parseUsageLimitDetails('resets in 30 minutes', NOW).resetsAtMs).toBe(NOW + 30 * 60_000);
  });

  it('reads local wall-clock reset times as the next occurrence', () => {
    const details = parseUsageLimitDetails('usage limit reached — resets 3am', NOW);
    expect(details.resetsAtMs).not.toBeNull();
    expect(details.resetsAtMs!).toBeGreaterThan(NOW);
    expect(details.resetsAtMs! - NOW).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('returns a null reset time when nothing parseable is present', () => {
    expect(parseUsageLimitDetails('usage limit reached, come back later', NOW).resetsAtMs).toBeNull();
  });
});
