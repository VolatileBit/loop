/**
 * Goal-mode domain: slugs, the goal folder layout, persistent round state,
 * and the declared-verify contract's file plumbing.
 *
 * A goal lives at `.loop/goals/<slug>/`:
 *
 *   goal.md                 — the goal text (the spec every session reads)
 *   issues/<slug>/NN-*.md   — agent-generated backlog; the goal slug doubles as the project
 *                             folder name, so the regular discovery/pipeline machinery applies
 *   verify/<issue-id>.cmd   — the verify command each implement session declared (one line)
 *   VERIFY.md               — shared verify knowledge, appended by sessions
 *   evaluations/round-N.md  — each round's evaluation verdict text
 *   state.json              — round counter, status, supersede lineage
 *
 * Everything here is main-repo-root `.loop/` state — outside any worktree, so
 * session writes to it never retract in-session verify evidence.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loopDir } from '../shared/paths.js';
import { parseDeclaredVerifyCmd } from '../verify/declared-verify.js';

export const GOAL_STATUSES = ['active', 'reached', 'blocked', 'planner-stuck'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type GoalState = {
  /** Completed plan→drain→evaluate rounds. */
  round: number;
  status: GoalStatus;
  /**
   * Supersede lineage: replacement issue id → the lineage's root issue id.
   * Each root gets at most `supersedeLimit` replacements; failing past that
   * budget stops the goal as blocked — repeated independent failures on the
   * same problem is a wall for a human, not more replanning.
   */
  lineage: Record<string, string>;
  /** Escalations recorded per issue id — bounds cross-round verify-failed retries. */
  attempts: Record<string, number>;
  createdAt: string;
};

export function goalsDir(root: string): string {
  return path.join(loopDir(root), 'goals');
}

export type GoalPaths = {
  slug: string;
  dir: string;
  goalDocPath: string;
  /** Plan sessions maintain this: batch structure, dependency rationale. */
  planDocPath: string;
  /** The issue root handed to discovery (contains one `<slug>/` project folder). */
  issuesDir: string;
  /** The project folder actual issue files live in. */
  issuesProjectDir: string;
  verifyDir: string;
  verifyNotesPath: string;
  evaluationsDir: string;
  statePath: string;
};

export function goalPaths(root: string, slug: string): GoalPaths {
  const dir = path.join(goalsDir(root), slug);
  return {
    slug,
    dir,
    goalDocPath: path.join(dir, 'goal.md'),
    planDocPath: path.join(dir, 'PLAN.md'),
    issuesDir: path.join(dir, 'issues'),
    issuesProjectDir: path.join(dir, 'issues', slug),
    verifyDir: path.join(dir, 'verify'),
    verifyNotesPath: path.join(dir, 'VERIFY.md'),
    evaluationsDir: path.join(dir, 'evaluations'),
    statePath: path.join(dir, 'state.json'),
  };
}

/** Derive a filesystem-safe slug from goal text (lowercase words joined by dashes, capped). */
export function slugifyGoal(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'goal';
}

export function goalExists(root: string, slug: string): boolean {
  return existsSync(goalPaths(root, slug).goalDocPath);
}

/** Create the goal folder skeleton and seed goal.md + state.json. */
export function createGoal(root: string, slug: string, goalText: string): GoalPaths {
  const paths = goalPaths(root, slug);
  mkdirSync(paths.issuesProjectDir, { recursive: true });
  mkdirSync(paths.verifyDir, { recursive: true });
  mkdirSync(paths.evaluationsDir, { recursive: true });
  writeFileSync(paths.goalDocPath, `${goalText.trim()}\n`);
  if (!existsSync(paths.verifyNotesPath)) {
    writeFileSync(
      paths.verifyNotesPath,
      '# Verify knowledge\n\nAppended by implement sessions: which commands verify what, and why.\n',
    );
  }
  saveGoalState(paths, { round: 0, status: 'active', lineage: {}, attempts: {}, createdAt: new Date().toISOString() });
  return paths;
}

export function loadGoalState(paths: GoalPaths): GoalState {
  try {
    const raw = JSON.parse(readFileSync(paths.statePath, 'utf8')) as Partial<GoalState>;
    return {
      round: typeof raw.round === 'number' ? raw.round : 0,
      status: (GOAL_STATUSES as readonly string[]).includes(raw.status as string)
        ? (raw.status as GoalStatus)
        : 'active',
      lineage: typeof raw.lineage === 'object' && raw.lineage !== null ? (raw.lineage as Record<string, string>) : {},
      attempts: typeof raw.attempts === 'object' && raw.attempts !== null ? (raw.attempts as Record<string, number>) : {},
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    };
  } catch {
    return { round: 0, status: 'active', lineage: {}, attempts: {}, createdAt: new Date().toISOString() };
  }
}

export function saveGoalState(paths: GoalPaths, state: GoalState): void {
  mkdirSync(path.dirname(paths.statePath), { recursive: true });
  writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/** Path of an issue's declared-verify file (`verify/<issue-id>.cmd`). */
export function declaredVerifyPath(paths: GoalPaths, issueId: string): string {
  return path.join(paths.verifyDir, `${issueId}.cmd`);
}

/**
 * The declared verify command for an issue, or null when the session never
 * declared one (first non-empty line, so a trailing newline or comment line
 * from the agent doesn't break it).
 */
export function readDeclaredVerifyCmd(paths: GoalPaths, issueId: string): string | null {
  try {
    return parseDeclaredVerifyCmd(readFileSync(declaredVerifyPath(paths, issueId), 'utf8'));
  } catch {
    return null;
  }
}

/** Every declared verify command so far, de-duplicated, keyed by issue id. */
export function listDeclaredVerifyCmds(paths: GoalPaths): Map<string, string> {
  const declared = new Map<string, string>();
  try {
    for (const name of readdirSync(paths.verifyDir).sort()) {
      if (!name.endsWith('.cmd')) continue;
      const issueId = name.slice(0, -'.cmd'.length);
      const cmd = readDeclaredVerifyCmd(paths, issueId);
      if (cmd) declared.set(issueId, cmd);
    }
  } catch {
    // no verify dir yet
  }
  return declared;
}

/** Markdown issue files currently in the goal backlog (relative names). */
export function listGoalIssueFiles(paths: GoalPaths): string[] {
  try {
    return readdirSync(paths.issuesProjectDir)
      .filter((name) => name.endsWith('.md'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

/**
 * Scan issue files for `Supersedes: <id>` lines and fold them into the
 * lineage map (replacement id → lineage root id). Returns the root ids whose
 * replacement count now exceeds `supersedeLimit` — the same problem failing
 * past its replan budget, which the driver treats as blocked.
 */
export function updateLineageFromIssues(
  paths: GoalPaths,
  lineage: Record<string, string>,
  supersedeLimit: number,
): { lineage: Record<string, string>; overLimit: string[] } {
  const next = { ...lineage };
  const overLimit: string[] = [];
  for (const file of listGoalIssueFiles(paths)) {
    const content = readFileSync(path.join(paths.issuesProjectDir, file), 'utf8');
    const id = content.match(/^id:\s*(\S+)/m)?.[1];
    const superseded = content.match(/^Supersedes:\s*(\S+)/m)?.[1];
    if (!id || !superseded) continue;
    if (next[id]) continue; // already recorded
    // Chains flatten to their root: superseding a replacement joins its lineage.
    const root = next[superseded] ?? superseded;
    next[id] = root;
    if (supersedeCount(next, root) > supersedeLimit && !overLimit.includes(root)) {
      overLimit.push(root);
    }
  }
  return { lineage: next, overLimit };
}

/** How many replacements this lineage root has burned so far. */
export function supersedeCount(lineage: Record<string, string>, rootId: string): number {
  return Object.values(lineage).filter((root) => root === rootId).length;
}

export type GoalSummary = {
  slug: string;
  status: GoalStatus;
  round: number;
  issueCount: number;
  /** First non-empty line of goal.md. */
  headline: string;
};

/** Every goal under `.loop/goals/`, for `loop goals`. */
export function listGoals(root: string): GoalSummary[] {
  const dir = goalsDir(root);
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => goalExists(root, name))
    .sort()
    .map((slug) => {
      const paths = goalPaths(root, slug);
      const state = loadGoalState(paths);
      let headline = '';
      try {
        headline =
          readFileSync(paths.goalDocPath, 'utf8')
            .split('\n')
            .map((line) => line.replace(/^#+\s*/, '').trim())
            .find((line) => line.length > 0) ?? '';
      } catch {
        // unreadable goal doc — listed with an empty headline
      }
      return {
        slug,
        status: state.status,
        round: state.round,
        issueCount: listGoalIssueFiles(paths).length,
        headline,
      };
    });
}
