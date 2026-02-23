/**
 * Issue-file discovery. Any `*.md` under a project subdirectory of issuesDir
 * (except `README.md`) with a resolvable `id`/`issue` frontmatter field
 * counts as an issue — there is no filename-pattern filter.
 *
 * Identity model:
 * - `project` = the immediate parent directory name (regardless of nesting depth).
 * - `id` is unique only within its project.
 * - `qualifiedId` = `${project}/${id}` is the single global identity string.
 *
 * Discovery throws a descriptive Error (for the caller to failStop on) when
 * two files resolve to the same qualifiedId, or when a non-README `*.md`
 * sits directly in issuesDir with no project subdirectory.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { PIPELINE_STAGE_NAMES, type PipelineStageName } from '../config/types.js';
import { resolveRoot } from '../shared/paths.js';
import {
  parseAcceptanceCriteria,
  parseBlockedBy,
  parseFrontmatter,
  resolveIssueId,
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

function parseLastStage(value: string | undefined): PipelineStageName | undefined {
  if (value !== undefined && (PIPELINE_STAGE_NAMES as readonly string[]).includes(value)) {
    return value as PipelineStageName;
  }
  return undefined;
}

export function discoverIssues(issuesDir: string, root: string = resolveRoot()): IssueRecord[] {
  const resolvedIssuesDir = path.resolve(root, issuesDir);
  const files = walkMarkdownFiles(resolvedIssuesDir);

  const flat = files.filter((filePath) => path.dirname(filePath) === resolvedIssuesDir);
  if (flat.length > 0) {
    throw new Error(
      [
        'Issue files must live inside a project subdirectory of the issues dir (e.g. issues/<feature>/<file>.md).',
        'These files sit directly in the issues dir with no project:',
        ...flat.map((filePath) => `  - ${path.relative(root, filePath)}`),
        'Move each into a project folder (a repo with no feature grouping can use a single folder, e.g. issues/backlog/).',
      ].join('\n'),
    );
  }

  const issues: IssueRecord[] = [];
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(content);
    const id = resolveIssueId(frontmatter);
    if (!id) continue;

    const project = path.basename(path.dirname(filePath));
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
    const prd = frontmatter.prd?.trim();
    if (prd) record.prd = prd;
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
