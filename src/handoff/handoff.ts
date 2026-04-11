/**
 * Per-issue handoff notes: durable context an agent stage leaves for the
 * next stage's fresh session, plus a *transient* "pending review feedback".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { handoffsDir } from '../shared/paths.js';

/** The minimal issue identity handoff files are keyed by. */
export type HandoffRef = { project: string; id: string };

export const LOOP_HANDOFF_HEADING = '## Loop handoff';

export const PENDING_REVIEW_FEEDBACK_HEADING = '## Pending review feedback (unresolved)';
const PENDING_START = '<!-- loop:pending-review-feedback:start -->';
const PENDING_END = '<!-- loop:pending-review-feedback:end -->';

export function handoffPath(root: string, issue: HandoffRef): string {
  return path.join(handoffsDir(root), issue.project, `${issue.id}.md`);
}

function readRaw(root: string, issue: HandoffRef): string | null {
  const filePath = handoffPath(root, issue);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf8');
}

function writeRaw(root: string, issue: HandoffRef, content: string): void {
  const filePath = handoffPath(root, issue);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

type SplitHandoff = {
  /** Durable narrative notes (everything outside the pending section). */
  notes: string;
  /** Body of the pending-review-feedback section (heading stripped), or null. */
  pending: string | null;
};

function splitHandoffContent(content: string): SplitHandoff {
  const startIdx = content.indexOf(PENDING_START);
  const endIdx = content.indexOf(PENDING_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { notes: content.trim(), pending: null };
  }

  const notes = `${content.slice(0, startIdx)}\n${content.slice(endIdx + PENDING_END.length)}`.trim();
  const section = content.slice(startIdx + PENDING_START.length, endIdx);
  const pending = section.replace(PENDING_REVIEW_FEEDBACK_HEADING, '').trim();
  return { notes, pending: pending || null };
}

export function readPendingReviewFeedback(root: string, issue: HandoffRef): string | null {
  const raw = readRaw(root, issue);
  if (raw === null) return null;
  return splitHandoffContent(raw).pending;
}
