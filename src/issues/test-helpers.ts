/** Shared vitest fixtures for the issues domain (not a test file itself). */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_TRIAGE_LABELS, type TriageLabels } from '../config/triage-labels.js';
import type { IssueRecord } from './types.js';

export const LABELS: TriageLabels = DEFAULT_TRIAGE_LABELS;

/** In-memory IssueRecord fixture; qualifiedId derived from project/id unless overridden. */
export function makeIssue(
  overrides: Partial<IssueRecord> & Pick<IssueRecord, 'id'>,
): IssueRecord {
  const project = overrides.project ?? 'PRD-001';
  const id = overrides.id;
  return {
    title: id,
    triage: LABELS.readyForAgent,
    project,
    qualifiedId: `${project}/${id}`,
    filePath: `/tmp/${project}/${id}.md`,
    relPath: `issues/${project}/${id}.md`,
    blockedBy: [],
    acceptanceCriteria: ['- [ ] criterion'],
    body: '',
    ...overrides,
  };
}

const tempDirs: string[] = [];

/** mkdtemp a root dir, tracked for cleanupTempDirs(). */
export function makeTempRoot(prefix = 'loop-issues-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
}

export type IssueFileSpec = {
  frontmatter?: Record<string, string>;
  body?: string;
};

/** Write an issue markdown file (frontmatter + body) at `relPath` under `root`. */
export function writeIssueFile(root: string, relPath: string, spec: IssueFileSpec = {}): string {
  const filePath = path.join(root, relPath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const frontmatter = spec.frontmatter ?? {};
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
  const content = `---\n${lines.join('\n')}\n---\n${spec.body ?? ''}`;
  writeFileSync(filePath, content);
  return filePath;
}
