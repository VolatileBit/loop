/**
 * Shared per-project notes: durable, cross-issue facts —
 * system and testing quirks, verify noise, where key conventions live — at
 * `.loop/notes/<project>.md`. Three-way split of durable context:
 *
 * - per-issue handoff (`.loop/handoffs/…`) — issue-scoped narrative between
 *   this issue's stages;
 * - project notes (this file) — agents' unreviewed working memory shared by
 *   every issue in the project; all pipeline stages read it, only implement
 *   and review sessions write it (fix stages are narrow fixups, and letting
 *   every stage write would balloon it);
 * - repo `CONTEXT.md` — reviewed, tracked knowledge; `loop polish` distills
 *   the notes into it when a project wraps up.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loopDir } from '../shared/paths.js';

export function projectNotesPath(root: string, project: string): string {
  return path.join(loopDir(root), 'notes', `${project}.md`);
}

/** Seeds an empty notes file on first touch; returns the absolute path for prompts. */
export function ensureProjectNotes(root: string, project: string): string {
  const filePath = projectNotesPath(root, project);
  if (!existsSync(filePath)) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      [
        `# Loop notes — ${project}`,
        '',
        'Durable, cross-issue facts for this project: system and testing quirks,',
        'verify commands and their known-harmless noise, where key modules and',
        'conventions live. Correct or remove stale entries instead of appending',
        "forever. Issue-specific narration belongs in that issue's handoff, not here.",
        '',
      ].join('\n'),
    );
  }
  return filePath;
}
