/**
 * Review verdict parsing: the `## Loop verdict` block a review session must
 * end with, plus inference fallbacks for malformed/missing blocks and the
 * fix-cycle exhaustion predicates.
 */

import { LOOP_VERDICT_HEADING } from './prompts.js';
import {
  LOOP_FINDING_FAMILIES_HEADING,
  type ReviewFindingFamily,
} from './convergence.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extracts the markdown body under `heading` up to the next `## ` heading or end of text. */
function extractSectionBody(text: string, heading: string): string | null {
  const match = text.match(new RegExp(`${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?:\\n## |$)`, 'i'));
  return match ? (match[1] ?? '').trim() : null;
}

export type ReviewSeverity = 'blocking' | 'nits-only' | 'none' | 'unknown';

export type ReviewVerdict = {
  changesRequested: boolean;
  severity: ReviewSeverity;
  summary: string;
  findingFamilies: ReviewFindingFamily[];
  /** Full review text (Standards + Spec + verdict block). */
  body: string;
};

export function parseReviewVerdict(text: string): ReviewVerdict {
  const body = text.trim();
  const block = extractSectionBody(body, LOOP_VERDICT_HEADING) ?? '';
  const changesRaw = block.match(/^changes-requested:\s*(yes|no)\s*$/im)?.[1]?.toLowerCase();
  const severityRaw = block.match(/^severity:\s*(blocking|nits-only|none)\s*$/im)?.[1]?.toLowerCase();
  const summaryRaw = block.match(/^summary:\s*(.+)\s*$/im)?.[1]?.trim();

  let severity: ReviewSeverity = 'unknown';
  if (severityRaw === 'blocking' || severityRaw === 'nits-only' || severityRaw === 'none') {
    severity = severityRaw;
  }

  let changesRequested: boolean;
  if (changesRaw === 'yes') changesRequested = true;
  else if (changesRaw === 'no') changesRequested = false;
  else changesRequested = inferChangesRequested(body, severity);

  if (severity === 'unknown' && !changesRaw) {
    severity = inferSeverity(body, changesRequested);
  }

  return {
    changesRequested,
    severity,
    summary: summaryRaw ?? inferSummary(changesRequested, severity),
    findingFamilies: parseFindingFamilies(body),
    body,
  };
}

/**
 * Fresh blocking reviews must supply the structured family ledger that drives
 * convergence. Legacy artifacts are still tolerated when history is loaded.
 */
export function reviewVerdictContractError(verdict: ReviewVerdict): string | null {
  if (reviewRequiresFix(verdict) && verdict.findingFamilies.length === 0) {
    return 'blocking review must report at least one structured finding family';
  }
  return null;
}

function parseFindingFamilies(body: string): ReviewFindingFamily[] {
  const block = extractSectionBody(body, LOOP_FINDING_FAMILIES_HEADING);
  if (!block) return [];

  const families: ReviewFindingFamily[] = [];
  for (const line of block.split('\n')) {
    const match = line.match(/^\s*-\s+`([a-z0-9]+(?:-[a-z0-9]+)*)`:\s*(.+?)\s*$/);
    if (!match?.[1] || !match[2]) continue;
    families.push({ id: match[1], invariant: match[2] });
  }
  return families;
}

function inferChangesRequested(body: string, severity: ReviewSeverity): boolean {
  if (/changes-requested:\s*no/i.test(body)) return false;
  if (/changes-requested:\s*yes/i.test(body)) return true;
  if (severity === 'none') return false;
  if (severity === 'nits-only' || severity === 'blocking') return true;
  if (/\b(no issues|looks good|ready to ship|lgtm)\b/i.test(body)) return false;
  return true;
}

function inferSeverity(body: string, changesRequested: boolean): ReviewSeverity {
  if (!changesRequested) return 'none';
  if (/severity:\s*nits-only/i.test(body) || /\bnit(s)?\b only/i.test(body)) return 'nits-only';
  if (/severity:\s*blocking/i.test(body) || /\bblocking\b/i.test(body)) return 'blocking';
  if (/\b(critical|security|missing requirement|spec fail)\b/i.test(body)) return 'blocking';
  return 'unknown';
}

function inferSummary(changesRequested: boolean, severity: ReviewSeverity): string {
  if (!changesRequested || severity === 'none') return 'Review passed — no changes requested.';
  if (severity === 'nits-only') return 'Nits only — no blocking changes required.';
  if (severity === 'blocking') return 'Blocking issues found — implementation fixes required.';
  return changesRequested ? 'Changes requested (verdict block missing or incomplete).' : 'Review passed.';
}

/** True when loop can mark the issue done (pass or nits-only). */
export function isReviewSatisfied(verdict: ReviewVerdict): boolean {
  if (!verdict.changesRequested) return true;
  return verdict.severity === 'nits-only' || verdict.severity === 'none';
}

/** True when loop should run an implementation fix pass. */
export function reviewRequiresFix(verdict: ReviewVerdict): boolean {
  return verdict.changesRequested && verdict.severity === 'blocking';
}

export function reviewFixAttemptsExhausted(fixAttempts: number, maxCycles: number): boolean {
  return fixAttempts >= maxCycles;
}

export function verifyFixAttemptsExhausted(fixAttempts: number, maxCycles: number): boolean {
  return reviewFixAttemptsExhausted(fixAttempts, maxCycles);
}

/** After a blocking review, run an implement fix only while cycles remain. */
export function shouldRunImplementFixAfterBlockingReview(fixAttempts: number, maxCycles: number): boolean {
  return fixAttempts < maxCycles;
}
