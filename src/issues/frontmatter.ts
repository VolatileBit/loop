/**
 * Issue-file frontmatter and body-section parsing.
 */

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (match === null) return { frontmatter: {}, body: content };
  const block = match[1] as string;
  const body = match[2] as string;

  const frontmatter: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

/** The issue's local id from its `id` (preferred) or `issue` frontmatter field. */
export function resolveIssueId(frontmatter: Record<string, string>): string | null {
  const id = frontmatter.id ?? frontmatter.issue;
  return id?.trim() ? id.trim() : null;
}

export function parseBlockedBy(body: string): string[] {
  const section = body.match(/## Blocked by\s*\n+([\s\S]*?)(?=\n## |\n*$)/)?.[1];
  if (section === undefined) return [];
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0 && !/^\(?none(?:\)|\b)/i.test(line));
}

export function parseAcceptanceCriteria(body: string): string[] {
  const section = body.match(/## Acceptance criteria\s*\n+([\s\S]*?)(?=\n## |\n*$)/)?.[1];
  if (section === undefined) return [];
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ['));
}

export function allCriteriaChecked(criteria: string[]): boolean {
  return criteria.length > 0 && criteria.every((line) => /^- \[x\]/i.test(line));
}
