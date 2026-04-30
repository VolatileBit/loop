/**
 * Scheduling: pick the next unblocked, runnable issue.
 */

import path from 'node:path';
import type { IssueRecord } from './types.js';

/** A `## Blocked by` entry reduced to the parts that identify an issue. */
export type BlockerRef = {
  /** Explicit project from a qualified id or a path; null = the referencing issue's own project. */
  project: string | null;
  id: string;
};

/** `[text](target)` at the start of an entry — anything after it is prose. */
const MARKDOWN_LINK_RE = /^\[([^\]]*)\]\(([^)]+)\)/;

/**
 * Reduce one raw entry to a project/id reference, or null when nothing
 * identifier-shaped is left.
 */
export function parseBlockerRef(entry: string): BlockerRef | null {
  let text = entry.trim();
  if (!text) return null;

  // A link's target is the machine-readable half; fall back to the link text
  // when the target is an anchor or an external URL rather than a file.
  const link = text.match(MARKDOWN_LINK_RE);
  if (link) {
    const target = link[2]!.trim();
    text = /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target) ? link[1]!.trim() : target;
  }

  // Backticks only quote; ids never contain whitespace, so anything past the
  // first token is prose ("02-schema — needed for the migration").
  text = (text.replace(/`/g, '').trim().split(/\s+/)[0] ?? '').replace(/[),.;:]+$/, '');
  if (!text) return null;

  // Path segments: keep the last two meaningful ones — `<project>/<id>`.
  const segments = text
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  const last = segments.pop();
  if (last === undefined) return null;
  const id = last.replace(/\.md$/i, '');
  if (!id) return null;

  return { project: segments.pop() ?? null, id };
}

/**
 * The textual `project/id` key an entry names, without checking whether that
 * issue exists — for reporting an unresolvable reference back to a human.
 */
export function resolveBlockedByKey(entry: string, referencingProject: string): string {
  const ref = parseBlockerRef(entry);
  if (!ref) return `${referencingProject}/${entry.trim()}`;
  return `${ref.project ?? referencingProject}/${ref.id}`;
}

/** Every lookup key an issue answers to when another issue references it. */
function blockerKeys(issue: IssueRecord): string[] {
  const stem = path.basename(issue.filePath).replace(/\.md$/i, '');
  const ids = stem === issue.id ? [issue.id] : [issue.id, stem];
  return [...ids.map((id) => `${issue.project}/${id}`), ...ids];
}

/** key → the issues answering to it; a key with several is too ambiguous to resolve. */
export type BlockerIndex = Map<string, Set<string>>;
