/**
 * Scheduling: pick the next unblocked, runnable issue. Completion is always
 * judged against *all* discovered issues (so cross-project blockers resolve
 * correctly); only the candidate pool is project-filtered.
 *
 * `## Blocked by` entries are written by hand and by plan sessions, in every
 * form a markdown list invites: a bare id, a qualified `project/id`, a link, a
 * backticked filename, a repo-relative path, any of them trailed by prose.
 * They are normalised to an id (plus an optional project) and then matched
 * against issues that actually exist — a reference matching nothing keeps its
 * dependent blocked, but is reported rather than stalling the backlog in
 * silence.
 */

import path from 'node:path';

import type { TriageLabels } from '../config/triage-labels.js';
import { isDone, isRunnableTriage } from './lifecycle.js';
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

export function buildBlockerIndex(issues: readonly IssueRecord[]): BlockerIndex {
  const index: BlockerIndex = new Map();
  for (const issue of issues) {
    for (const key of blockerKeys(issue)) {
      const hits = index.get(key) ?? new Set<string>();
      hits.add(issue.qualifiedId);
      index.set(key, hits);
    }
  }
  return index;
}

/**
 * Resolve one entry to the qualifiedId of a real issue, or null. An explicit
 * project wins; then the referencing issue's own project; a repo-wide match is
 * the last resort, and only when exactly one issue answers to the id.
 */
export function resolveBlocker(
  entry: string,
  referencingProject: string,
  index: BlockerIndex,
): string | null {
  const ref = parseBlockerRef(entry);
  if (!ref) return null;

  const candidates = ref.project
    ? [`${ref.project}/${ref.id}`, `${referencingProject}/${ref.id}`, ref.id]
    : [`${referencingProject}/${ref.id}`, ref.id];

  for (const key of candidates) {
    const hits = index.get(key);
    if (hits?.size === 1) return [...hits][0]!;
  }
  return null;
}

export type DanglingBlocker = {
  /** The issue whose `## Blocked by` section carries the reference. */
  issue: IssueRecord;
  /** The entry exactly as written in the file. */
  entry: string;
  /** The `project/id` it appears to name — what a human should go looking for. */
  key: string;
};

/**
 * Blocker references naming no discovered issue. These hold their dependents
 * back indefinitely, so callers print them: silence here reads as "no runnable
 * issues" with no cause given.
 */
export function findDanglingBlockers(issues: readonly IssueRecord[]): DanglingBlocker[] {
  const index = buildBlockerIndex(issues);
  const dangling: DanglingBlocker[] = [];
  for (const issue of issues) {
    for (const entry of issue.blockedBy) {
      if (resolveBlocker(entry, issue.project, index) !== null) continue;
      dangling.push({ issue, entry, key: resolveBlockedByKey(entry, issue.project) });
    }
  }
  return dangling;
}

/** One line per dangling reference, for a caller to print once after discovery. */
export function reportDanglingBlockers(issues: readonly IssueRecord[]): void {
  const dangling = findDanglingBlockers(issues);
  if (dangling.length === 0) return;
  console.warn(
    `[loop] ${dangling.length} "## Blocked by" reference(s) name no known issue — their dependents stay blocked until the reference is corrected or removed:`,
  );
  for (const { issue, entry, key } of dangling) {
    console.warn(`  - ${issue.qualifiedId} is blocked by "${entry}" (looked for ${key})`);
  }
}

/**
 * First runnable, unblocked issue — from the project-filtered candidate pool
 * when `projectFilter` is given, while `doneIds` is always computed from
 * `allIssues`. Relies on discovery's qualifiedId ordering for priority.
 */
export function pickNextIssue(
  allIssues: IssueRecord[],
  labels: TriageLabels,
  projectFilter?: (issue: IssueRecord) => boolean,
): IssueRecord | null {
  const doneIds = new Set(
    allIssues.filter((issue) => isDone(issue, labels)).map((issue) => issue.qualifiedId),
  );
  const index = buildBlockerIndex(allIssues);

  const candidates = allIssues.filter((issue) => {
    if (projectFilter && !projectFilter(issue)) return false;
    if (isDone(issue, labels)) return false;
    if (!isRunnableTriage(issue.triage, labels)) return false;
    return issue.blockedBy.every((entry) => {
      const blocker = resolveBlocker(entry, issue.project, index);
      // An unresolvable reference keeps its dependent blocked: it is a typo or
      // a deleted issue, and running the work early is the costlier guess.
      return blocker !== null && doneIds.has(blocker);
    });
  });

  return candidates[0] ?? null;
}
