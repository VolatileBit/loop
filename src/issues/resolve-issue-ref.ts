import type { IssueRecord } from './types.js';

/**
 * Resolve a CLI-supplied issue reference: an exact `project/id` qualifiedId
 * match, or a bare local id accepted as shorthand if and only if it is
 * unambiguous repo-wide. Throws a descriptive Error otherwise (listing the
 * candidate projects for an ambiguous shorthand).
 */
export function resolveIssueRef(ref: string, allIssues: IssueRecord[]): IssueRecord {
  const trimmed = ref.trim();

  const qualified = allIssues.find((issue) => issue.qualifiedId === trimmed);
  if (qualified) return qualified;

  const byLocalId = allIssues.filter((issue) => issue.id === trimmed);
  if (byLocalId.length === 1) return byLocalId[0]!;

  if (byLocalId.length > 1) {
    const projects = byLocalId.map((issue) => issue.project).sort();
    throw new Error(
      [
        `Issue reference "${ref}" is ambiguous — a matching local id exists in ${byLocalId.length} projects: ${projects.join(', ')}.`,
        `Use a qualified id instead, e.g. ${byLocalId[0]!.qualifiedId}.`,
      ].join('\n'),
    );
  }

  throw new Error(`Unknown issue reference "${ref}" — no issue has that qualified id (project/id) or local id.`);
}
