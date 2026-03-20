/**
 * The console line prefix.
 *
 * Two kinds of line exist, and telling them apart matters more than anything
 * else the prefix could carry:
 *
 *   11:29:57 [16|review-6] │ I'll start by reading the issue file.   ← the agent
 *   11:29:57 [16|review-6] starting review session                    ← loop
 *   11:29:57 [loop] 3/5 workers active                                ← loop, no issue
 *
 * Issue-scoped lines are labelled `[<id>|<stage>]` and take a colour keyed on
 * the issue, so scrolling a long run shows at a glance where each issue starts
 * and ends. The *project* is deliberately absent: it is constant for a whole
 * run in the common case, and the run header already names it in full.
 *
 * Loop's own voice versus the agent's is carried by the `│` gutter that
 * `AgentStreamDisplay` adds after this prefix — a character, not a colour, so
 * the distinction survives `NO_COLOR` and the plain-text invocation log, which
 * is exactly where it is needed most.
 */

import { detail, worker } from './style.js';

/** Stage suffixes the pipeline appends to a `project/id` label. */
const ISSUE_STAGE_SUFFIX =
  /-(implement|verify|verify-fix-\d+|review-round-\d+|review-fix-\d+|complete)$/;

/**
 * Compact a pipeline stage for the prefix. Only `review-round-N` shortens: the
 * word "round" carries no information the number doesn't. The fix stages keep
 * their full names on purpose — `verify-1` reads like the first verify rather
 * than the first *fix cycle after* a failed verify, and `fix-1` loses which
 * loop it belongs to entirely.
 */
export function compactStageName(stage: string): string {
  const round = stage.match(/^review-round-(\d+)$/);
  return round ? `review-${round[1]}` : stage;
}

/** The `project/id-stage` label split into the parts the prefix renders. */
export function parseStageLabel(label: string): {
  project: string | null;
  issueId: string | null;
  stage: string | null;
} {
  if (!label) return { project: null, issueId: null, stage: null };

  const slash = label.indexOf('/');
  if (slash <= 0) return { project: null, issueId: label, stage: null };

  const project = label.slice(0, slash);
  const issueAndStage = label.slice(slash + 1);
  const stageMatch = issueAndStage.match(ISSUE_STAGE_SUFFIX);
  if (stageMatch?.index === undefined) {
    return { project, issueId: issueAndStage, stage: null };
  }
  return {
    project,
    issueId: issueAndStage.slice(0, stageMatch.index),
    stage: compactStageName(stageMatch[1]!),
  };
}

/**
 * Hard ceiling on a rendered line, prefix included. A terminal soft-wraps a
 * longer line wherever the window happens to end, which breaks the gutter rail:
 * the wrapped remainder starts at column 0 with no prefix and no `│`, so a
 * single long sentence severs the vertical line. Wrapping it ourselves keeps
 * every continuation inside the rail.
 */
export const MAX_LINE_WIDTH = 180;

/**
 * `HH:MM:SS ` — stamped onto every line by the invocation-log tee (see
 * logs/invocation-log.ts), which sits downstream of every decision made here.
 * Budgeting for it is what makes `MAX_LINE_WIDTH` the width actually seen.
 */
const TIMESTAMP_WIDTH = 9;

/**
 * Break `text` into chunks that fit `width` visible columns, preferring word
 * boundaries. A word longer than the whole width (a URL, a stack frame, a
 * base64 blob) is hard-split rather than allowed to overflow.
 */
export function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let current = '';

  const flush = (): void => {
    lines.push(current);
    current = '';
  };

  for (const word of text.split(' ')) {
    let piece = word;
    // A single word wider than the line can never fit; emit full-width slices
    // until the remainder does.
    while (piece.length > width) {
      if (current !== '') flush();
      lines.push(piece.slice(0, width));
      piece = piece.slice(width);
    }
    if (current === '') current = piece;
    else if (current.length + 1 + piece.length <= width) current += ` ${piece}`;
    else {
      flush();
      current = piece;
    }
  }
  if (current !== '' || lines.length === 0) lines.push(current);
  return lines;
}

/** Visible width of a prefix, ignoring any styling codes wrapped around it. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function prefixWidth(prefix: string): number {
  return prefix.replace(ANSI_RE, '').length;
}

/**
 * Columns left for text on a line carrying `prefix`. `reserved` covers whatever
 * sits between the prefix and the text — the gutter and its spaces, a field
 * label column. Every width decision goes through here, so a line that is
 * truncated and a line that is wrapped share one right edge.
 */
export function contentWidth(prefix: string, reserved = 0): number {
  return MAX_LINE_WIDTH - TIMESTAMP_WIDTH - prefixWidth(prefix) - reserved;
}

/**
 * Trim an issue id down to what distinguishes it on screen: `issue-07` → `07`.
 * Ids that are not `<word>-<number>` shaped are left alone rather than guessed at.
 */
export function shortIssueId(issueId: string): string {
  return issueId.match(/^[A-Za-z]+[-_](\d+)$/)?.[1] ?? issueId;
}

/**
 * Format a line prefix. `kind` selects loop's own voice from the agent's only
 * for styling — the visible label is identical, because the gutter is what
 * separates them.
 */
export function formatOutputPrefix(
  kind: string,
  label: string = '',
  suffix: string = '',
): string {
  const { project, issueId, stage } = parseStageLabel(label);

  // Nothing to name but the run itself: always `[loop]`, whichever voice asked.
  // A bare `[agent]` would claim an issue-less line came from a session.
  if (issueId === null) {
    const fields = suffix ? ['loop', suffix] : ['loop'];
    return `[${fields.join('|')}]`;
  }

  const fields = [shortIssueId(issueId), ...(stage ? [stage] : []), ...(suffix ? [suffix] : [])];
  const prefix = `[${fields.join('|')}]`;
  // Colour is keyed on the *qualified* id so two projects' `issue-01` differ,
  // even though only the short id is printed.
  const colourKey = project ? `${project}/${issueId}` : issueId;
  return kind === 'think' ? detail(prefix) : worker(colourKey, prefix);
}
