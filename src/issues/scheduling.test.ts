import { describe, expect, it, vi } from 'vitest';

import {
  findDanglingBlockers,
  parseBlockerRef,
  pickNextIssue,
  reportDanglingBlockers,
  resolveBlockedByKey,
} from './scheduling.js';
import { LABELS, makeIssue } from './test-helpers.js';

describe('resolveBlockedByKey', () => {
  it('resolves a bare entry within the referencing issue project', () => {
    expect(resolveBlockedByKey('issue-02', 'PRD-006')).toBe('PRD-006/issue-02');
  });

  it('resolves a qualified entry cross-project, as-is', () => {
    expect(resolveBlockedByKey('PRD-003/issue-04', 'PRD-006')).toBe('PRD-003/issue-04');
  });

  it('trims whitespace', () => {
    expect(resolveBlockedByKey(' issue-02 ', 'PRD-006')).toBe('PRD-006/issue-02');
  });
});

describe('parseBlockerRef', () => {
  it('reads the forms issue files actually use', () => {
    expect(parseBlockerRef('issue-02')).toEqual({ project: null, id: 'issue-02' });
    expect(parseBlockerRef('issue-02.md')).toEqual({ project: null, id: 'issue-02' });
    expect(parseBlockerRef('`issue-02.md`')).toEqual({ project: null, id: 'issue-02' });
    expect(parseBlockerRef('[issue-02](issue-02.md)')).toEqual({ project: null, id: 'issue-02' });
    expect(parseBlockerRef('[Schema first](./issue-02.md)')).toEqual({
      project: null,
      id: 'issue-02',
    });
    expect(parseBlockerRef('PRD-003/issue-04')).toEqual({ project: 'PRD-003', id: 'issue-04' });
    expect(parseBlockerRef('[x](../PRD-003/issue-04.md)')).toEqual({
      project: 'PRD-003',
      id: 'issue-04',
    });
    expect(parseBlockerRef('issues/PRD-003/issue-04.md')).toEqual({
      project: 'PRD-003',
      id: 'issue-04',
    });
  });

  it('drops the prose that trails a reference', () => {
    expect(parseBlockerRef('issue-02 — needs the migration first')).toEqual({
      project: null,
      id: 'issue-02',
    });
    expect(parseBlockerRef('[issue-02](issue-02.md) (schema)')).toEqual({
      project: null,
      id: 'issue-02',
    });
  });

  it('keeps the link text when the target is not a file', () => {
    expect(parseBlockerRef('[issue-02](https://example.test/tracker/9)')).toEqual({
      project: null,
      id: 'issue-02',
    });
  });

  it('returns null when nothing identifier-shaped remains', () => {
    expect(parseBlockerRef('   ')).toBeNull();
    expect(parseBlockerRef('`.md`')).toBeNull();
  });
});

describe('blocker resolution against real issues', () => {
  it('resolves link and backtick forms that used to block forever', () => {
    const done = makeIssue({ id: 'issue-05', triage: LABELS.done });
    const viaLink = makeIssue({ id: 'issue-06', blockedBy: ['[issue-05](issue-05.md)'] });
    const viaBacktick = makeIssue({ id: 'issue-07', blockedBy: ['`issue-05.md`'] });

    expect(pickNextIssue([done, viaLink], LABELS)?.id).toBe('issue-06');
    expect(pickNextIssue([done, viaBacktick], LABELS)?.id).toBe('issue-07');
  });

  it('resolves a link whose path names another project', () => {
    const doneInA = makeIssue({ id: 'issue-01', project: 'PRD-A', triage: LABELS.done });
    const blockedInB = makeIssue({
      id: 'issue-02',
      project: 'PRD-B',
      blockedBy: ['[issue-01](../PRD-A/issue-01.md)'],
    });
    expect(pickNextIssue([doneInA, blockedInB], LABELS)?.qualifiedId).toBe('PRD-B/issue-02');
  });

  it('matches a reference to the blocker filename when it differs from the id', () => {
    const done = makeIssue({
      id: '05',
      triage: LABELS.done,
      filePath: '/tmp/PRD-001/05-add-schema.md',
    });
    const blocked = makeIssue({ id: '06', blockedBy: ['05-add-schema.md'] });
    expect(pickNextIssue([done, blocked], LABELS)?.id).toBe('06');
  });

  it('keeps a dependent blocked when the reference names no known issue', () => {
    const blocked = makeIssue({ id: 'issue-06', blockedBy: ['issue-99'] });
    expect(pickNextIssue([blocked], LABELS)).toBeNull();
  });

  it('does not resolve an ambiguous bare id across projects', () => {
    const doneInA = makeIssue({ id: 'shared', project: 'PRD-A', triage: LABELS.done });
    const doneInB = makeIssue({ id: 'shared', project: 'PRD-B', triage: LABELS.done });
    const blocked = makeIssue({ id: 'issue-01', project: 'PRD-C', blockedBy: ['shared'] });
    expect(pickNextIssue([doneInA, doneInB, blocked], LABELS)).toBeNull();
  });
});

describe('dangling blocker reporting', () => {
  it('names the issue, the entry as written, and the id it looked for', () => {
    const blocked = makeIssue({ id: 'issue-06', blockedBy: ['[gone](../PRD-Z/gone.md)'] });
    expect(findDanglingBlockers([blocked])).toEqual([
      { issue: blocked, entry: '[gone](../PRD-Z/gone.md)', key: 'PRD-Z/gone' },
    ]);
  });

  it('stays silent when every reference resolves', () => {
    const done = makeIssue({ id: 'issue-05', triage: LABELS.done });
    const blocked = makeIssue({ id: 'issue-06', blockedBy: ['`issue-05.md`'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      reportDanglingBlockers([done, blocked]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('pickNextIssue (ported semantics)', () => {
  it('retries verify-failed issues when criteria are checked', () => {
    const failed = makeIssue({
      id: 'issue-06',
      triage: LABELS.verifyFailed,
      acceptanceCriteria: ['- [x] one', '- [x] two'],
    });
    const later = makeIssue({ id: 'issue-07' });
    expect(pickNextIssue([failed, later], LABELS)?.qualifiedId).toBe('PRD-001/issue-06');
  });

  it('keeps dependents blocked until the blocker is done', () => {
    const failed = makeIssue({
      id: 'issue-05',
      triage: LABELS.verifyFailed,
      acceptanceCriteria: ['- [x] one'],
    });
    const blocked = makeIssue({ id: 'issue-06', blockedBy: ['issue-05'] });
    expect(pickNextIssue([failed, blocked], LABELS)?.id).toBe('issue-05');
  });

  it('unblocks dependents when the blocker is done', () => {
    const done = makeIssue({ id: 'issue-05', triage: LABELS.done, acceptanceCriteria: ['- [x] one'] });
    const blocked = makeIssue({ id: 'issue-06', blockedBy: ['issue-05'] });
    expect(pickNextIssue([done, blocked], LABELS)?.id).toBe('issue-06');
  });

  it('skips non-runnable triage (needs-human, wontfix, needs-triage)', () => {
    const needsHuman = makeIssue({ id: 'issue-01', triage: LABELS.readyForHuman });
    const wontfix = makeIssue({ id: 'issue-02', triage: LABELS.wontfix });
    const needsTriage = makeIssue({ id: 'issue-03', triage: LABELS.needsTriage });
    expect(pickNextIssue([needsHuman, wontfix, needsTriage], LABELS)).toBeNull();
  });
});

describe('pickNextIssue project-aware semantics', () => {
  it('bare blockedBy entries resolve within the referencing project, not globally', () => {
    // issue-01 is done in PRD-A but not in PRD-B: PRD-B/issue-02 stays blocked.
    const doneInA = makeIssue({ id: 'issue-01', project: 'PRD-A', triage: LABELS.done });
    const notDoneInB = makeIssue({ id: 'issue-01', project: 'PRD-B', triage: LABELS.needsTriage });
    const blockedInB = makeIssue({ id: 'issue-02', project: 'PRD-B', blockedBy: ['issue-01'] });

    expect(pickNextIssue([doneInA, notDoneInB, blockedInB], LABELS)).toBeNull();
  });

  it('qualified blockedBy entries resolve cross-project', () => {
    const doneInA = makeIssue({ id: 'issue-01', project: 'PRD-A', triage: LABELS.done });
    const blockedInB = makeIssue({ id: 'issue-02', project: 'PRD-B', blockedBy: ['PRD-A/issue-01'] });

    expect(pickNextIssue([doneInA, blockedInB], LABELS)?.qualifiedId).toBe('PRD-B/issue-02');
  });

  it('projectFilter narrows the candidate pool but doneIds still come from all issues', () => {
    const outOfScopeDone = makeIssue({ id: 'issue-01', project: 'PRD-A', triage: LABELS.done });
    const outOfScopeReady = makeIssue({ id: 'issue-02', project: 'PRD-A' });
    const inScopeBlockedCrossScope = makeIssue({
      id: 'issue-01',
      project: 'PRD-B',
      blockedBy: ['PRD-A/issue-01'],
    });

    const projectFilter = (issue: { project: string }) => issue.project === 'PRD-B';
    const picked = pickNextIssue(
      [outOfScopeDone, outOfScopeReady, inScopeBlockedCrossScope],
      LABELS,
      projectFilter,
    );

    // PRD-A/issue-02 is runnable but out of project; PRD-B/issue-01 is unblocked
    // because its cross-project blocker is done in the *unscoped* done set.
    expect(picked?.qualifiedId).toBe('PRD-B/issue-01');
  });

  it('returns null when every in-project candidate is blocked, even if out-of-project work exists', () => {
    const outOfScopeReady = makeIssue({ id: 'issue-01', project: 'PRD-A' });
    const inScopeBlocked = makeIssue({ id: 'issue-01', project: 'PRD-B', blockedBy: ['PRD-A/issue-01'] });

    const picked = pickNextIssue([outOfScopeReady, inScopeBlocked], LABELS, (issue) => issue.project === 'PRD-B');
    expect(picked).toBeNull();
  });

  it('behaves identically with no projectFilter (unscoped run)', () => {
    const a = makeIssue({ id: 'issue-01', project: 'PRD-A' });
    const b = makeIssue({ id: 'issue-01', project: 'PRD-B' });
    expect(pickNextIssue([a, b], LABELS)?.qualifiedId).toBe('PRD-A/issue-01');
  });
});

it('resolves cross-project dependency paths through nested issues containers', () => {
  const prerequisite = makeIssue({ project: '20260913-gallery', id: '01-upload', triage: LABELS.done });
  const waiting = makeIssue({ project: '20260914-export', id: '01-export', blockedBy: ['[Upload](specs/20260913-gallery/issues/01-upload.md)'] });
  // A same-named local issue must not intercept an explicit path to the other project.
  const local = makeIssue({ project: waiting.project, id: '01-upload', triage: LABELS.readyForAgent });
  expect(pickNextIssue([prerequisite, waiting, local], LABELS)?.qualifiedId).toBe('20260914-export/01-export');
});
