/**
 * Spec context document resolution (prompt enrichment only — decoupled from
 * issue identity). Best-effort: returns a repo-relative path to the parent
 * spec doc, or null. Never throws — a missing/unreadable specsDir or
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
 * `SPEC-006` matches `SPEC-006-loop-refactor.md` (and `SPEC-006.md`) but not
 * `SPEC-0061-other.md`.
 */
function matchesPrefix(fileName: string, prefix: string): boolean {
  const lowerName = fileName.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (!lowerName.startsWith(lowerPrefix)) return false;
  const next = lowerName.charAt(lowerPrefix.length);
  return next === '' || !/[a-z0-9]/.test(next);
}

/** Candidates offered by init and used for implicit spec context at runtime. */
export function findProjectSpecs(project: string, specsDir: string, root: string): string[] {
  const dir = path.resolve(root, specsDir);
  const candidates = listMarkdownFiles(dir)
    .filter((name) => matchesPrefix(name, project))
    .map((name) => path.relative(root, path.join(dir, name)));
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.toLowerCase() !== project.toLowerCase()) continue;
      const spec = path.join(dir, entry.name, 'spec.md');
      if (existsSync(spec) && statSync(spec).isFile()) candidates.unshift(path.relative(root, spec));
    }
  } catch {
    // Missing or unreadable spec roots simply provide no folder candidates.
  }
  return candidates;
}

/**
 * Resolve an explicit spec override: as a repo-relative path if it points at an
 * existing file, else as a filename prefix within specsDir. An override that
 * matches nothing resolves to null (never falls back to project-name matching
 * — an explicit-but-wrong pointer should surface, not silently swap docs).
 */
function resolveSpecOverride(override: string, specsDir: string | null, root: string): string | null {
  const asPath = path.resolve(root, override);
  try {
    if (existsSync(asPath) && statSync(asPath).isFile()) return path.relative(root, asPath);
  } catch {
    // fall through to prefix matching
  }
  if (!specsDir) return null;
  const match = listMarkdownFiles(specsDir).find((name) => matchesPrefix(name, override));
  return match ? path.relative(root, path.join(specsDir, match)) : null;
}

/**
 * Resolve the spec doc for an issue. Precedence (most specific wins):
 * `spec:` issue frontmatter, then the project's `projects.<name>.spec` config,
 * then a case-insensitive `issue.project` filename-prefix match in `specsDir`.
 * Explicit overrides accept a repo-relative path (works even without
 * `specsDir`) or a filename prefix within `specsDir`.
 *
 * `root` is the tree the session will work in. When it is a worktree, a spec in
 * a gitignored directory exists only in the main checkout — a relative path
 * would resolve to nothing there and the session would correctly report that
 * the doc does not exist, then infer the feature's scope from somewhere else.
 * So an *untracked* doc resolves to an absolute path into `mainRoot`; a tracked
 * one stays relative, because an absolute path anchors the agent's sense of the
 * project root to the main checkout, where it may then edit the wrong tree.
 */
export function resolveIssueSpec(
  issue: IssueRecord,
  config: Pick<LoopConfig, 'specsDir' | 'projects'>,
  root: string = resolveRoot(),
  /** The main checkout, when `root` is a worktree. Defaults to `root`. */
  mainRoot: string = root,
): string | null {
  const relPath = resolveSpecRelPath(issue, config, mainRoot);
  if (relPath === null) return null;
  // Only a real repository can have worktrees, so outside one a relative path
  // always resolves and is the less surprising form.
  if (!isGitRepository(mainRoot)) return relPath;
  // Tracked files reach every worktree; anything else lives only in the main
  // checkout, so hand the session the one path that actually resolves there.
  return isTrackedFile(mainRoot, relPath) ? relPath : path.resolve(mainRoot, relPath);
}

function resolveSpecRelPath(
  issue: IssueRecord,
  config: Pick<LoopConfig, 'specsDir' | 'projects'>,
  root: string,
): string | null {
  const specsDir = config.specsDir ? path.resolve(root, config.specsDir) : null;

  const override = issue.spec ?? config.projects[issue.project]?.spec;
  if (override) return resolveSpecOverride(override, specsDir, root);

  if (!specsDir) return null;
  const candidates = findProjectSpecs(issue.project, specsDir, root);
  // Ambiguous implicit context needs an explicit issue/project pointer.
  return candidates.length === 1 ? candidates[0]! : null;
}
