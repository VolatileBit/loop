/**
 * Per-issue isolation, before worktrees.
 *
 * Each issue ran on a throwaway `loop/iso/*` branch cut from the current HEAD.
 * Anything already dirty in the tree was stashed first and restored after, so a
 * run could not silently absorb work the human had in progress.
 *
 * The whole scheme is planned as a list of git commands rather than executed
 * inline, so the dry-run path prints exactly what a real run would do.
 */

export type WorkingState = {
  /** Branch the repo sat on before loop touched it. */
  branch: string;
  /** Whether anything was uncommitted when loop arrived. */
  dirty: boolean;
  /** Stash the dirt landed in, when there was any. */
  stashRef: string | null;
};

const UNSAFE = /[^a-zA-Z0-9._-]+/g;

/**
 * Branch name for one issue. Git refuses a few shapes outright (leading dot,
 * trailing `.lock`, `..`), and an issue id comes from a filename a human wrote,
 * so everything outside a conservative set collapses to a dash.
 */
export function isolationBranchName(issueId: string, attempt = 0): string {
  const slug = issueId
    .trim()
    .toLowerCase()
    .replace(UNSAFE, '-')
    // git rejects `..` outright, and a leading dot hides the ref from most tooling
    .replace(/\.{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const base = `loop/iso/${slug === '' ? 'issue' : slug}`;
  return attempt > 0 ? `${base}-${attempt}` : base;
}

/** Paths in `git status --porcelain` output, ignoring the status columns. */
export function changedPaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      const arrow = path.indexOf(' -> ');
      return arrow === -1 ? path : path.slice(arrow + 4);
    });
}

export function isDirty(porcelain: string): boolean {
  return changedPaths(porcelain).length > 0;
}

/**
 * `git stash push` prints the ref it created. Older git said "Saved working
 * directory and index state WIP on <branch>: <sha> <subject>"; newer git leads
 * with the ref. Match the ref itself rather than the sentence around it.
 */
export function parseStashRef(output: string): string | null {
  const match = output.match(/stash@\{\d+\}/);
  return match === null ? null : match[0];
}

/** Commands that move the repo onto `target`, stashing first when dirty. */
export function planSwap(current: string, target: string, dirty: boolean): string[] {
  const plan: string[] = [];
  if (dirty) plan.push(`git stash push --include-untracked -m "loop: parked ${current}"`);
  plan.push(`git checkout -B ${target}`);
  return plan;
}

/** Commands that put the repo back the way loop found it. */
export function planRestore(state: WorkingState): string[] {
  const plan = [`git checkout ${state.branch}`];
  if (state.stashRef !== null) plan.push(`git stash pop ${state.stashRef}`);
  return plan;
}
