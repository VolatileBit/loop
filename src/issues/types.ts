import type { PipelineStageName } from '../config/types.js';

/**
 * Frontmatter fields loop reads from an issue file.
 *
 * `id` is *locally* unique — unique only within its project folder, not
 * repo-wide. `prd` optionally overrides which PRD document is surfaced as
 * context (never affects identity). `lastStage` is the resume checkpoint
 * written as a stage begins.
 */
export type IssueFrontmatter = {
  id: string;
  title: string;
  triage: string;
  prd?: string;
  lastStage?: PipelineStageName;
};

export type IssueRecord = IssueFrontmatter & {
  /** Immediate parent directory name under issuesDir — the issue's structural project. */
  project: string;
  /** `${project}/${id}` — the single globally-unique identity string used everywhere. */
  qualifiedId: string;
  filePath: string;
  /** Path relative to the repo root. */
  relPath: string;
  /** Raw `## Blocked by` entries — bare local ids (same project) or qualified `project/id`. */
  blockedBy: string[];
  acceptanceCriteria: string[];
  body: string;
};
