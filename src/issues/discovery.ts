/**
 * Issue-file discovery. Any `*.md` under a project subdirectory of issuesDir
 * (except `README.md`) with a resolvable `id`/`issue` frontmatter field
 * counts as an issue — there is no filename-pattern filter.
 *
 * Identity model:
 * - `<root>/<project>/issues/` is a planning project's issue container. Only
 *   files in that container are issues; sibling specs/maps are context.
 * - Other layouts retain the immediate parent directory as `project`.
 * - `id` is unique only within its project.
 * - `qualifiedId` = `${project}/${id}` is the single global identity string.
 *
 * Discovery throws a descriptive Error (for the caller to failStop on) when
 * two files resolve to the same qualifiedId, or when an ID-bearing issue
 * sits directly in issuesDir with no project subdirectory.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { PIPELINE_STAGE_NAMES, type PipelineStageName } from '../config/types.js';
import { resolveRoot } from '../shared/paths.js';
import {
  parseAcceptanceCriteria,
  parseBlockedBy,
  parseFrontmatter,
  resolveIssueId,
  resolveSpecPointer,
} from './frontmatter.js';
import type { IssueRecord } from './types.js';

/** All `*.md` files under `dir` (recursive), excluding any `README.md`. */
export function walkMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
      out.push(full);
    }
  }
  return out;
}

/** Recognize a planning folder by its issues container, even before a spec exists. */
export function hasIssueContainer(projectDir: string): boolean {
  try { return statSync(path.join(projectDir, 'issues')).isDirectory(); } catch { return false; }
}

function collectIssueFiles(dir: string, issueRoot: string): { filePath: string; project: string }[] {
  if (!existsSync(dir)) return [];
  if (dir !== issueRoot && hasIssueContainer(dir)) {
    return walkMarkdownFiles(path.join(dir, 'issues'))
      .map((filePath) => ({ filePath, project: path.basename(dir) }));
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // A planning map stays out of execution even before the first issue is written.
      if (entry.name === 'map' && existsSync(path.join(dir, 'spec.md'))) return [];
      return collectIssueFiles(filePath, issueRoot);
    }
    return entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md'
      ? [{ filePath, project: path.basename(dir) }]
      : [];
  });
}

function parseLastStage(value: string | undefined): PipelineStageName | undefined {
  if (value !== undefined && (PIPELINE_STAGE_NAMES as readonly string[]).includes(value)) {
    return value as PipelineStageName;
  }
  return undefined;
}

export function discoverIssues(issuesDir: string, root: string = resolveRoot()): IssueRecord[] {
  const resolvedIssuesDir = path.resolve(root, issuesDir);
  const files = collectIssueFiles(resolvedIssuesDir, resolvedIssuesDir);

  const issues: IssueRecord[] = [];
  for (const { filePath, project } of files) {
    const content = readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(content);
    const id = resolveIssueId(frontmatter);
    if (!id) continue;
    if (path.dirname(filePath) === resolvedIssuesDir) {
      throw new Error(
        `Issue files must live inside a project subdirectory of the issue root (e.g. specs/<date-project>/issues/<file>.md or issues/<project>/<file>.md).\n` +
        `${path.relative(root, filePath)} sits directly in the issue root with no project. Move it into a project folder.`,
      );
    }
    const record: IssueRecord = {
      id,
      project,
      qualifiedId: `${project}/${id}`,
      title: frontmatter.title ?? id,
      triage: frontmatter.triage ?? 'unknown',
      filePath,
      relPath: path.relative(root, filePath),
      blockedBy: parseBlockedBy(body),
      acceptanceCriteria: parseAcceptanceCriteria(body),
      body,
    };
    const spec = resolveSpecPointer(frontmatter);
    if (spec) record.spec = spec;
    const lastStage = parseLastStage(frontmatter.lastStage);
    if (lastStage !== undefined) record.lastStage = lastStage;
    issues.push(record);
  }

  const byQualifiedId = new Map<string, IssueRecord[]>();
  for (const issue of issues) {
    const existing = byQualifiedId.get(issue.qualifiedId);
    if (existing) existing.push(issue);
    else byQualifiedId.set(issue.qualifiedId, [issue]);
  }
  const duplicates = [...byQualifiedId.entries()].filter(([, records]) => records.length > 1);
  if (duplicates.length > 0) {
    throw new Error(
      [
        'Duplicate issue id(s) within the same project — ids must be unique per project folder:',
        ...duplicates.flatMap(([qualifiedId, records]) => [
          `  ${qualifiedId}:`,
          ...records.map((record) => `    - ${record.relPath}`),
        ]),
      ].join('\n'),
    );
  }

  return issues.sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId, undefined, { numeric: true }));
}
