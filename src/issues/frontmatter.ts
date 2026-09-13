/**
 * Issue-file frontmatter and body-section parsing. Ported from
 * scripts/loop-loop.ts with strict-TS guards (regex groups can be
 * undefined under noUncheckedIndexedAccess).
 */

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const block = match?.[1];
  const body = match?.[2];
  if (block === undefined || body === undefined) return { frontmatter: {}, body: content };

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

/** Prefer the canonical spec pointer while accepting existing issue files. */
export function resolveSpecPointer(frontmatter: Record<string, string>): string | null {
  const spec = frontmatter.spec ?? frontmatter.prd;
  return spec?.trim() ? spec.trim() : null;
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
