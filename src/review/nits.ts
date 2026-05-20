/**
 * Nits tracking: nits-only review findings are appended to the repo-local
 * `.loop/nits.md` for later batch cleanup instead of blocking the issue.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { nitsPath, loopDir } from '../shared/paths.js';
import { LOOP_NITS_DECISIONS_HEADING, LOOP_NITS_HEADING } from './prompts.js';
import type { ReviewVerdict } from './verdict.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSectionBody(text: string, heading: string): string | null {
  const match = text.match(new RegExp(`${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?:\\n## |$)`, 'i'));
  return match ? (match[1] ?? '').trim() : null;
}

/** Bullet items under the optional `## Loop nits` section, present when severity is nits-only. */
export function parseNits(text: string): string[] {
  const block = extractSectionBody(text.trim(), LOOP_NITS_HEADING);
  if (!block) return [];
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

/** The slice of an issue nits logging needs. */
export type NitsIssue = { qualifiedId: string; title: string };

/** True when the nits backlog has at least one per-issue section to work through. */
export function hasNitsEntries(content: string): boolean {
  return /^## \S/m.test(content);
}

export type NitsDecision = {
  qualifiedId: string;
  action: 'fixed' | 'dismissed';
  note: string;
};

/**
 * Parse the `## Loop nits decisions` block of a fix-nits session's final
 * response: one `- <project/id>: fixed|dismissed — <note>` bullet per issue
 * section. Throws on a missing block or an unparseable bullet — a malformed
 * report fails the batch (and restores the backlog) instead of silently
 * dropping findings.
 */
export function parseNitsDecisions(text: string): NitsDecision[] {
  const block = extractSectionBody(text.trim(), LOOP_NITS_DECISIONS_HEADING);
  if (block === null) {
    throw new Error(`fix-nits response has no "${LOOP_NITS_DECISIONS_HEADING}" block`);
  }
  const bullets = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
  if (bullets.length === 0) {
    throw new Error(`"${LOOP_NITS_DECISIONS_HEADING}" block has no decision bullets`);
  }
  return bullets.map((line) => {
    const match = line.match(/^-\s*(\S+)\s*:\s*(fixed|dismissed)\s*(?:[—–-]\s*(.*))?$/i);
    if (!match) {
      throw new Error(`unparseable nits decision line: "${line}" (expected "- <project/id>: fixed|dismissed — note")`);
    }
    return {
      qualifiedId: match[1]!,
      action: match[2]!.toLowerCase() as 'fixed' | 'dismissed',
      note: (match[3] ?? '').trim(),
    };
  });
}

/** Appends nits-only review findings to `.loop/nits.md` under `root` (the main repo). */
export function appendNits(
  root: string,
  issue: NitsIssue,
  verdict: ReviewVerdict,
  reviewRunDir: string,
): void {
  const nits = parseNits(verdict.body);
  const items = nits.length > 0 ? nits : [verdict.summary];
  mkdirSync(loopDir(root), { recursive: true });
  const section = [
    `## ${issue.qualifiedId} — ${issue.title} (${new Date().toISOString().slice(0, 10)})`,
    '',
    ...items.map((item) => `- ${item}`),
    '',
    `Review: ${path.relative(root, reviewRunDir)}/review.md`,
    '',
    '',
  ].join('\n');
  appendFileSync(nitsPath(root), section);
  console.log(
    `[loop] logged ${items.length} nit(s) for ${issue.qualifiedId} to ${path.relative(root, nitsPath(root))}`,
  );
}
