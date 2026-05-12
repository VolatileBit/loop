/**
 * Per-issue handoff notes: durable context an agent stage leaves for the next
 * stage's fresh session, plus a *transient* "pending review feedback" section
 * used to resume straight into a reviewFix stage without re-running review.
 *
 * Files live at `.loop/handoffs/<project>/<id>.md`, nested by project to mirror
 * the issues/ tree (local ids are only unique within their project).
 *
 * The pending-review-feedback section is delimited by explicit marker
 * comments (not just a heading) because the feedback body is a full review
 * verdict that itself contains `## ` headings.
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

function renderHandoffContent(notes: string, pending: string | null): string {
  const parts: string[] = [];
  if (notes.trim()) parts.push(notes.trim());
  if (pending?.trim()) {
    parts.push([PENDING_START, PENDING_REVIEW_FEEDBACK_HEADING, '', pending.trim(), PENDING_END].join('\n'));
  }
  if (parts.length === 0) return '';
  return `${parts.join('\n\n')}\n`;
}

/**
 * Reads the *durable* handoff note left by a previous stage on this issue, if
 * any (see `## Loop handoff`). Any transient pending-review-feedback section
 * is excluded — read that explicitly via readPendingReviewFeedback().
 */
export function readHandoff(root: string, issue: HandoffRef): string | null {
  const raw = readRaw(root, issue);
  if (raw === null) return null;
  const { notes } = splitHandoffContent(raw);
  return notes || null;
}

/**
 * Persists an agent-authored handoff note (replacing the previous durable
 * note). A no-op when the note is empty. Preserves any pending-review-feedback
 * section already in the file.
 */
export function writeHandoffIfPresent(root: string, issue: HandoffRef, note: string | null): void {
  if (!note?.trim()) return;
  const raw = readRaw(root, issue);
  const pending = raw === null ? null : splitHandoffContent(raw).pending;
  writeRaw(root, issue, renderHandoffContent(note.trim(), pending));
}

/**
 * Records Loop's authoritative post-stage commit after an agent-authored
 * handoff was persisted. Agent notes describe the tree as the agent left it;
 * when Loop then creates the fallback commit, later stages must see that newer
 * state instead of treating an "unstaged" note as current.
 */
export function recordHandoffFallbackCommit(
  root: string,
  issue: HandoffRef,
  commit: { committed: boolean; message: string; sha: string | null },
): void {
  if (!commit.committed || commit.sha === null) return;
  const raw = readRaw(root, issue);
  if (raw === null) return;
  const { notes, pending } = splitHandoffContent(raw);
  if (!notes) return;
  const state = `Loop post-stage state: fallback commit ${commit.sha.slice(0, 7)} created — ${commit.message}.`;
  writeRaw(root, issue, renderHandoffContent(`${notes}\n\n${state}`, pending));
}

/** Empties the handoff file (durable notes *and* pending feedback) — called on issue completion. */
export function clearHandoff(root: string, issue: HandoffRef): void {
  const filePath = handoffPath(root, issue);
  if (existsSync(filePath)) writeFileSync(filePath, '');
}

/**
 * Copies the handoff's full content to `archivePath` (when non-empty), then
 * empties it — completion keeps an audit copy beside the run artifacts instead
 * of destroying the trail.
 */
export function archiveAndClearHandoff(root: string, issue: HandoffRef, archivePath: string): void {
  const raw = readRaw(root, issue);
  if (raw?.trim()) {
    mkdirSync(path.dirname(archivePath), { recursive: true });
    writeFileSync(archivePath, raw);
  }
  clearHandoff(root, issue);
}

/**
 * Records the review verdict that triggered a reviewFix stage, so a later
 * resume can rebuild the fix prompt without re-running review.
 */
export function writePendingReviewFeedback(root: string, issue: HandoffRef, feedback: string): void {
  const raw = readRaw(root, issue) ?? '';
  const { notes } = splitHandoffContent(raw);
  writeRaw(root, issue, renderHandoffContent(notes, feedback.trim() || null));
}

export function readPendingReviewFeedback(root: string, issue: HandoffRef): string | null {
  const raw = readRaw(root, issue);
  if (raw === null) return null;
  return splitHandoffContent(raw).pending;
}

/** Removes the transient section once the review round is resolved; durable notes are kept. */
export function clearPendingReviewFeedback(root: string, issue: HandoffRef): void {
  const raw = readRaw(root, issue);
  if (raw === null) return;
  const { notes, pending } = splitHandoffContent(raw);
  if (pending === null) return;
  writeRaw(root, issue, renderHandoffContent(notes, null));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extracts the markdown body under `heading` up to the next `## ` heading or end of text. */
function extractSectionBody(text: string, heading: string): string | null {
  const match = text.match(new RegExp(`${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?:\\n## |$)`, 'i'));
  return match ? (match[1] ?? '').trim() : null;
}

/** Agent-authored handoff note from the optional `## Loop handoff` block, for the next stage's fresh session. */
export function parseHandoffNote(text: string): string | null {
  return extractSectionBody(text.trim(), LOOP_HANDOFF_HEADING);
}
