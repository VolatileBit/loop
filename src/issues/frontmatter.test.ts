import { describe, expect, it } from 'vitest';

import {
  allCriteriaChecked,
  parseAcceptanceCriteria,
  parseBlockedBy,
  parseFrontmatter,
  resolveIssueId,
} from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('splits frontmatter key/values from the body', () => {
    const { frontmatter, body } = parseFrontmatter(
      '---\nid: issue-07\ntitle: Per-task timeouts\ntriage: ready\n---\n## Context\n\nBody text.\n',
    );
    expect(frontmatter).toEqual({ id: 'issue-07', title: 'Per-task timeouts', triage: 'ready' });
    expect(body).toBe('## Context\n\nBody text.\n');
  });

  it('keeps values containing colons intact', () => {
    const { frontmatter } = parseFrontmatter('---\ntitle: fix: the thing\n---\nbody');
    expect(frontmatter.title).toBe('fix: the thing');
  });

  it('returns the whole content as body when there is no frontmatter', () => {
    const { frontmatter, body } = parseFrontmatter('# Just a doc\n');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Just a doc\n');
  });

  it('handles CRLF line endings', () => {
    const { frontmatter, body } = parseFrontmatter('---\r\nid: issue-01\r\n---\r\nbody');
    expect(frontmatter.id).toBe('issue-01');
    expect(body).toBe('body');
  });
});

describe('resolveIssueId', () => {
  it('prefers id over issue and trims whitespace', () => {
    expect(resolveIssueId({ id: ' issue-01 ', issue: 'other' })).toBe('issue-01');
    expect(resolveIssueId({ issue: 'issue-02' })).toBe('issue-02');
  });

  it('returns null when neither field resolves', () => {
    expect(resolveIssueId({})).toBeNull();
    expect(resolveIssueId({ id: '  ' })).toBeNull();
  });
});

describe('parseBlockedBy', () => {
  it('extracts list entries and skips "none"', () => {
    const body = '## Blocked by\n\n- issue-02\n- PRD-003/issue-04\n\n## Acceptance criteria\n';
    expect(parseBlockedBy(body)).toEqual(['issue-02', 'PRD-003/issue-04']);
    expect(parseBlockedBy('## Blocked by\n\n- None\n')).toEqual([]);
    expect(parseBlockedBy('## Blocked by\n\n- (none)\n')).toEqual([]);
  });

  it('returns [] when the section is missing', () => {
    expect(parseBlockedBy('## Context\n\nstuff')).toEqual([]);
  });
});

describe('parseAcceptanceCriteria / allCriteriaChecked', () => {
  it('extracts checkbox lines only', () => {
    const body = '## Acceptance criteria\n\n- [ ] one\n- [x] two\nnot a checkbox\n\n## Notes\n';
    expect(parseAcceptanceCriteria(body)).toEqual(['- [ ] one', '- [x] two']);
  });

  it('allCriteriaChecked requires at least one criterion and all checked (case-insensitive)', () => {
    expect(allCriteriaChecked([])).toBe(false);
    expect(allCriteriaChecked(['- [x] one', '- [X] two'])).toBe(true);
    expect(allCriteriaChecked(['- [x] one', '- [ ] two'])).toBe(false);
  });
});
