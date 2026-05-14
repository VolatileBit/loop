/**
 * PRD-context document resolution (prompt enrichment only — decoupled from
 * issue identity). Best-effort: returns a repo-relative path to the parent
 * PRD/feature doc, or null. Never throws — a missing/unreadable prdsDir or
 * an unmatched project simply disables the context line.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { LoopConfig } from '../config/types.js';
import { isGitRepository, isTrackedFile } from '../git/status.js';
import { resolveRoot } from '../shared/paths.js';
import type { IssueRecord } from './types.js';

function listMarkdownFiles(dir: string): string[] {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

/**
 * Case-insensitive filename-prefix match with a boundary check, so project
 * `PRD-006` matches `PRD-006-loop-refactor.md` (and `PRD-006.md`) but not
 * `PRD-0061-other.md`.
 */
function matchesPrefix(fileName: string, prefix: string): boolean {
  const lowerName = fileName.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (!lowerName.startsWith(lowerPrefix)) return false;
  const next = lowerName.charAt(lowerPrefix.length);
  return next === '' || !/[a-z0-9]/.test(next);
}

/**
 * Resolve an explicit prd override: as a repo-relative path if it points at an
 * existing file, else as a filename prefix within prdsDir. An override that
 * matches nothing resolves to null (never falls back to project-name matching
 * — an explicit-but-wrong pointer should surface, not silently swap docs).
 */
function resolvePrdOverride(override: string, prdsDir: string | null, root: string): string | null {
  const asPath = path.resolve(root, override);
  try {
    if (existsSync(asPath) && statSync(asPath).isFile()) return path.relative(root, asPath);
  } catch {
    // fall through to prefix matching
  }
  if (!prdsDir) return null;
  const match = listMarkdownFiles(prdsDir).find((name) => matchesPrefix(name, override));
  return match ? path.relative(root, path.join(prdsDir, match)) : null;
}

/**
 * Resolve the PRD/feature doc for an issue. Precedence (most specific wins):
 * `prd:` issue frontmatter, then the project's `projects.<name>.prd` config,
 * then a case-insensitive `issue.project` filename-prefix match in `prdsDir`.
 * Explicit overrides accept a repo-relative path (works even without
 * `prdsDir`) or a filename prefix within `prdsDir`.
 *
 * `root` is the tree the session will work in. When it is a worktree, a PRD in
 * a gitignored directory exists only in the main checkout — a relative path
 * would resolve to nothing there and the session would correctly report that
 * the doc does not exist, then infer the feature's scope from somewhere else.
 * So an *untracked* doc resolves to an absolute path into `mainRoot`; a tracked
 * one stays relative, because an absolute path anchors the agent's sense of the
 * project root to the main checkout, where it may then edit the wrong tree.
 */
export function resolveIssuePrd(
  issue: IssueRecord,
  config: Pick<LoopConfig, 'prdsDir' | 'projects'>,
  root: string = resolveRoot(),
  /** The main checkout, when `root` is a worktree. Defaults to `root`. */
  mainRoot: string = root,
): string | null {
  const relPath = resolvePrdRelPath(issue, config, mainRoot);
  if (relPath === null) return null;
  // Only a real repository can have worktrees, so outside one a relative path
  // always resolves and is the less surprising form.
  if (!isGitRepository(mainRoot)) return relPath;
  // Tracked files reach every worktree; anything else lives only in the main
  // checkout, so hand the session the one path that actually resolves there.
  return isTrackedFile(mainRoot, relPath) ? relPath : path.resolve(mainRoot, relPath);
}

function resolvePrdRelPath(
  issue: IssueRecord,
  config: Pick<LoopConfig, 'prdsDir' | 'projects'>,
  root: string,
): string | null {
  const prdsDir = config.prdsDir ? path.resolve(root, config.prdsDir) : null;

  const override = issue.prd ?? config.projects[issue.project]?.prd;
  if (override) return resolvePrdOverride(override, prdsDir, root);

  if (!prdsDir) return null;
  const projectMatch = listMarkdownFiles(prdsDir).find((name) => matchesPrefix(name, issue.project));
  return projectMatch ? path.relative(root, path.join(prdsDir, projectMatch)) : null;
}
