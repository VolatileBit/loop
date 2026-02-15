/**
 * Shared usage-limit / rate-limit heuristic. Matches quota errors across
 * providers — avoid bare `429` (matches timestamps like …742934). Each
 * provider extends this with its own CLI-specific phrasings.
 *
 * The "hit your … limit" branch is deliberately loose about which *window* is
 * named. Vendors rename these without notice — Claude Code has said "usage
 * limit", "5-hour limit" and now "session limit" — and the cost of missing one
 * is not a missed message but a wrong outcome: loop treats the dead session as
 * a completed one, so a review escalates on a verdict nobody gave. Which window
 * it was matters only for the wait policy, and `parseUsageLimitDetails` reads
 * that separately.
 */
export const SHARED_USAGE_LIMIT_RE =
  /you'?ve (?:hit|reached) your (?:[\w-]+ ){0,2}limit|(?:usage|session|weekly) limits? (?:reached|exceeded)|usage limits? (?:have been )?exceeded|usage_limit_reached|rate limit exceeded|rate_limit_exceeded|rate_limit_error|quota exceeded|too many requests|resource_exhausted|out of requests|\bHTTP\s+429\b|"status"\s*:\s*429|"code"\s*:\s*429|statusCode["']?\s*[:=]\s*429/i;

export function isSharedUsageLimitError(text: string): boolean {
  return SHARED_USAGE_LIMIT_RE.test(text);
}

/** Which limit window was hit, and (when the CLI said) the epoch-ms it lifts. */
export type UsageLimitScope = 'session' | 'weekly';
export type UsageLimitDetails = {
  scope: UsageLimitScope;
  resetsAtMs: number | null;
  /** Loop's effective next probe time, including reset buffers or unknown-reset cadence. */
  retryAtMs?: number;
};

/** Epoch values may be seconds or milliseconds; anything below ~2001-09 in ms is seconds. */
function epochToMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

const DURATION_UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** The next occurrence of a local wall-clock time like "3am" / "11:30pm", strictly after `now`. */
function nextLocalTimeMs(hour12: number, minute: number, meridiem: string, nowMs: number): number {
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  const candidate = new Date(nowMs);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= nowMs) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

/**
 * Best-effort extraction of which limit was hit and when it lifts, from
 * whatever text the CLI produced (stream events, stderr, result text). Formats
 * are CLI- and version-volatile, so every pattern is conservative: a miss just
 * returns `resetsAtMs: null`, which the wait policy handles by probing — a
 * wrong timestamp would sleep the run at the wrong time.
 */
export function parseUsageLimitDetails(text: string, nowMs: number = Date.now()): UsageLimitDetails {
  const scope: UsageLimitScope = /week|seven[_-]?day|7[- ]day/i.test(text) ? 'weekly' : 'session';

  // Structured resetsAt fields (claude's rate_limit_event, API error payloads).
  const jsonField = text.match(/"resets?_?[aA]t"\s*:\s*"?(\d{9,13})"?/);
  if (jsonField) return { scope, resetsAtMs: epochToMs(Number(jsonField[1])) };

  // "Claude AI usage limit reached|1719414000" — epoch after a pipe.
  const pipedEpoch = text.match(/usage limit reached\|(\d{9,13})/i);
  if (pipedEpoch) return { scope, resetsAtMs: epochToMs(Number(pipedEpoch[1])) };

  // ISO 8601 timestamps near a reset/retry phrase.
  const iso = text.match(
    /(?:reset|retry|try again)[^.\n]*?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
  );
  if (iso) {
    const parsed = Date.parse(iso[1]!);
    if (!Number.isNaN(parsed)) return { scope, resetsAtMs: parsed };
  }

  // "try again in 2 hours" / "resets in 30 minutes".
  const relative = text.match(/(?:try again|resets?)\s+in\s+(\d+)\s+(minute|hour|day)s?/i);
  if (relative) {
    return { scope, resetsAtMs: nowMs + Number(relative[1]) * DURATION_UNIT_MS[relative[2]!.toLowerCase()]! };
  }

  // "resets 3am" / "resets at 11:30pm" — local wall-clock time.
  const wallClock = text.match(/resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (wallClock) {
    return {
      scope,
      resetsAtMs: nextLocalTimeMs(Number(wallClock[1]), Number(wallClock[2] ?? 0), wallClock[3]!, nowMs),
    };
  }

  return { scope, resetsAtMs: null };
}
