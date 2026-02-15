import { describe, expect, it } from 'vitest';

import { isSharedInfraError, nextRetryDelayMs, parseInfraError } from './infra-error.js';

describe('parseInfraError', () => {
  it('names the fault behind the failures that motivated retrying', () => {
    // Observed: a session that died 96 seconds in emitting server_error.
    expect(parseInfraError('{"type":"error","error":"server_error"}')).toBe('server-error');
    // Observed: 25 minutes of review lost to a severed response stream.
    expect(parseInfraError('API Error: Connection closed mid-response')).toBe('connection-dropped');
    expect(parseInfraError('{"type":"overloaded_error"}')).toBe('overloaded');
    expect(parseInfraError('502 Bad Gateway')).toBe('gateway');
    expect(parseInfraError('getaddrinfo ENOTFOUND api.example.test')).toBe('network-unreachable');
  });

  it('stays quiet on failures that are about the work, not the transport', () => {
    expect(parseInfraError('3 tests failed')).toBeNull();
    expect(parseInfraError('error')).toBeNull();
    expect(parseInfraError('TypeError: cannot read property of undefined')).toBeNull();
    expect(parseInfraError('authentication failed')).toBeNull();
    // A bare status number in a duration or token count must not read as a 5xx.
    expect(parseInfraError('executionTime: 502934ms')).toBeNull();
    expect(parseInfraError('the suite asserts a 500 response is handled')).toBeNull();
  });

  it('does not claim a usage limit as its own', () => {
    expect(isSharedInfraError('usage limit reached')).toBe(false);
    expect(isSharedInfraError('rate_limit_exceeded')).toBe(false);
  });
});

describe('nextRetryDelayMs', () => {
  it('doubles per attempt and stops at the cap', () => {
    const policy = { attempts: 5, initialDelayMs: 1000, maxDelayMs: 4000 };
    const noJitter = () => 0.5;
    expect(nextRetryDelayMs(policy, 1, noJitter)).toBe(1000);
    expect(nextRetryDelayMs(policy, 2, noJitter)).toBe(2000);
    expect(nextRetryDelayMs(policy, 3, noJitter)).toBe(4000);
    expect(nextRetryDelayMs(policy, 9, noJitter)).toBe(4000);
  });

  it('spreads parallel workers that failed together across a ±25% window', () => {
    const policy = { attempts: 2, initialDelayMs: 1000, maxDelayMs: 60_000 };
    expect(nextRetryDelayMs(policy, 1, () => 0)).toBe(750);
    expect(nextRetryDelayMs(policy, 1, () => 1)).toBe(1250);
    // Workers coming back in lockstep would hit the recovering provider as one spike.
    const spread = new Set([0.1, 0.4, 0.9].map((r) => nextRetryDelayMs(policy, 1, () => r)));
    expect(spread.size).toBe(3);
  });
});
