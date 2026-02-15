/**
 * Shared classifier for sessions killed by the *provider's* infrastructure
 * rather than by anything about the work: a dropped connection, an overloaded
 * backend, a 5xx. These are worth retrying in place — the same prompt against
 * the same tree usually succeeds moments later — which is the opposite of an
 * ordinary session failure, where retrying just burns the same money again.
 *
 * Sibling to usage-limit.ts, and deliberately narrower: it is checked *after*
 * the usage-limit probe (a quota hit has its own remedy) and must never match
 * an agent's own prose about a failing test, a bare status number, or a bare
 * "error". A false positive here retries work that will fail identically; a
 * false negative only costs what the code already cost before this existed.
 *
 * Loop's own wall/idle timeouts are excluded on purpose: an agent that hung is
 * likely to hang again, and it already has its own `stuckReason` handling.
 */

/** Named so a retry, and an exhausted one, can say what it was retrying. */
export type InfraErrorSignature =
  | 'overloaded'
  | 'gateway'
  | 'server-error'
  | 'connection-dropped'
  | 'network-unreachable'
  /**
   * The CLI reported a transport failure in its own phrasing, which the shared
   * table does not name (see each provider's `isInfraError`). Never produced by
   * `parseInfraError` — only by the caller falling back to it.
   */
  | 'provider-reported';

/** Ordered most-specific first: the first match names the failure. */
const INFRA_ERROR_SIGNATURES: readonly { signature: InfraErrorSignature; pattern: RegExp }[] = [
  {
    signature: 'overloaded',
    pattern:
      /overloaded_error|"type"\s*:\s*"overloaded"|\bservice unavailable\b|\bHTTP\s+503\b|"status(?:Code)?"\s*:\s*503/i,
  },
  {
    signature: 'gateway',
    pattern: /\bbad gateway\b|\bgateway time-?out\b|\bHTTP\s+50[24]\b|"status(?:Code)?"\s*:\s*50[24]/i,
  },
  {
    signature: 'server-error',
    pattern:
      /\bserver_error\b|\binternal server error\b|"type"\s*:\s*"api_error"|\bHTTP\s+500\b|"status(?:Code)?"\s*:\s*500/i,
  },
  {
    signature: 'connection-dropped',
    pattern:
      /connection closed mid-?response|\bECONNRESET\b|\bEPIPE\b|socket hang ?up|premature close|connection reset by peer/i,
  },
  {
    signature: 'network-unreachable',
    pattern:
      /\bENOTFOUND\b|\bEAI_AGAIN\b|\bECONNREFUSED\b|\bETIMEDOUT\b|getaddrinfo\b[^\n]*\bfailed|network is unreachable/i,
  },
];

/** Which infrastructure fault the text reports, or null when it reports none. */
export function parseInfraError(text: string): InfraErrorSignature | null {
  for (const { signature, pattern } of INFRA_ERROR_SIGNATURES) {
    if (pattern.test(text)) return signature;
  }
  return null;
}

/** The shared predicate every provider's `isInfraError` builds on. */
export function isSharedInfraError(text: string): boolean {
  return parseInfraError(text) !== null;
}

/** Exponential, capped, and jittered — see `nextRetryDelayMs`. */
export type AgentRetryPolicy = {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
};

/**
 * Delay before retry `attempt` (1 = the first retry). Jitter is not decoration:
 * parallel workers fail together on one outage, and without it they would all
 * come back at the same instant and hit the recovering provider as a spike.
 */
export function nextRetryDelayMs(
  policy: AgentRetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponential = policy.initialDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitter = 1 + (random() * 2 - 1) * 0.25;
  return Math.max(0, Math.round(capped * jitter));
}
