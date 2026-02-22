import type { IssueRecord } from './types.js';

/** Distinct project names across the discovered issues, sorted. */
export function listProjects(issues: IssueRecord[]): string[] {
  return [...new Set(issues.map((issue) => issue.project))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

/**
 * Predicate matching issues in `project` (exact, case-insensitive match on
 * `issue.project`). Throws a descriptive Error listing valid projects when no
 * issue matches, so `loop run <project>` can fail fast helpfully.
 */
export function resolveProjectFilter(
  issues: IssueRecord[],
  project: string,
): (issue: IssueRecord) => boolean {
  const wanted = project.trim().toLowerCase();
  const matches = issues.some((issue) => issue.project.toLowerCase() === wanted);
  if (!matches) {
    const projects = listProjects(issues);
    throw new Error(
      [
        `No issues found in project "${project}".`,
        projects.length > 0 ? `Available projects: ${projects.join(', ')}` : 'No projects discovered at all.',
      ].join('\n'),
    );
  }
  return (issue) => issue.project.toLowerCase() === wanted;
}
