import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDirs, makeTempRoot } from '../issues/test-helpers.js';
import {
  archiveAndClearHandoff,
  clearHandoff,
  clearPendingReviewFeedback,
  handoffPath,
  parseHandoffNote,
  readHandoff,
  readPendingReviewFeedback,
  recordHandoffFallbackCommit,
  writeHandoffIfPresent,
  writePendingReviewFeedback,
} from './handoff.js';

const ISSUE = { project: 'PRD-006', id: 'issue-07' };

afterEach(() => {
  cleanupTempDirs();
});

describe('handoffPath', () => {
  it('nests by project under .loop/handoffs, mirroring the issues tree', () => {
    const root = makeTempRoot();
    expect(handoffPath(root, ISSUE)).toBe(path.join(root, '.loop', 'handoffs', 'PRD-006', 'issue-07.md'));
  });

  it('keeps same local ids in different projects at distinct paths', () => {
    const root = makeTempRoot();
    const a = handoffPath(root, { project: 'PRD-A', id: 'issue-01' });
    const b = handoffPath(root, { project: 'PRD-B', id: 'issue-01' });
    expect(a).not.toBe(b);
  });
});

describe('readHandoff / writeHandoffIfPresent / clearHandoff', () => {
  it('returns null when no handoff file exists', () => {
    const root = makeTempRoot();
    expect(readHandoff(root, ISSUE)).toBeNull();
  });

  it('round-trips a handoff note, creating project directories as needed', () => {
    const root = makeTempRoot();
    writeHandoffIfPresent(root, ISSUE, 'Implemented the parser; tests in parser.test.ts.');
    expect(readHandoff(root, ISSUE)).toBe('Implemented the parser; tests in parser.test.ts.');
  });

  it('ignores empty/whitespace-only notes', () => {
    const root = makeTempRoot();
    writeHandoffIfPresent(root, ISSUE, '   \n');
    writeHandoffIfPresent(root, ISSUE, null);
    expect(existsSync(handoffPath(root, ISSUE))).toBe(false);
  });

  it('replaces the previous durable note on rewrite', () => {
    const root = makeTempRoot();
    writeHandoffIfPresent(root, ISSUE, 'first note');
    writeHandoffIfPresent(root, ISSUE, 'second note');
    expect(readHandoff(root, ISSUE)).toBe('second note');
  });

  it('records an authoritative fallback commit after an agent leaves stale worktree state', () => {
    const root = makeTempRoot();
    writeHandoffIfPresent(
      root,
      ISSUE,
      'Changes remain unstaged; create the fallback commit externally.',
    );

    recordHandoffFallbackCommit(root, ISSUE, {
      committed: true,
      message: 'fix: close the review finding (PRD-006/issue-07)',
      sha: '1234567890abcdef',
    });

    expect(readHandoff(root, ISSUE)).toContain(
      'Loop post-stage state: fallback commit 1234567 created — fix: close the review finding (PRD-006/issue-07).',
    );
  });

  it('clearHandoff empties the file entirely', () => {
    const root = makeTempRoot();
    writeHandoffIfPresent(root, ISSUE, 'note');
    writePendingReviewFeedback(root, ISSUE, 'feedback');
    clearHandoff(root, ISSUE);
    expect(readHandoff(root, ISSUE)).toBeNull();
    expect(readPendingReviewFeedback(root, ISSUE)).toBeNull();
    expect(readFileSync(handoffPath(root, ISSUE), 'utf8')).toBe('');
  });
});

describe('pending review feedback section', () => {
  it('round-trips feedback even when the handoff file did not exist', () => {
    const root = makeTempRoot();
    writePendingReviewFeedback(root, ISSUE, 'Fix the null check in resolve.ts.');
    expect(readPendingReviewFeedback(root, ISSUE)).toBe('Fix the null check in resolve.ts.');
    expect(readHandoff(root, ISSUE)).toBeNull();
  });

  it('coexists with durable notes without corrupting either', () => {
    const root = makeTempRoot();
    writeHandoffIfPresent(root, ISSUE, 'durable note');
    writePendingReviewFeedback(root, ISSUE, 'blocking finding');

    expect(readHandoff(root, ISSUE)).toBe('durable note');
    expect(readPendingReviewFeedback(root, ISSUE)).toBe('blocking finding');
  });

  it('survives feedback bodies that contain ## headings of their own', () => {
    const root = makeTempRoot();
    const verdict = ['## Standards', 'Missing tests.', '', '## Loop verdict', 'changes-requested: yes'].join('\n');
    writeHandoffIfPresent(root, ISSUE, 'durable note');
    writePendingReviewFeedback(root, ISSUE, verdict);

    expect(readPendingReviewFeedback(root, ISSUE)).toBe(verdict);
    expect(readHandoff(root, ISSUE)).toBe('durable note');
  });

  it('a later durable-note rewrite preserves pending feedback', () => {
    const root = makeTempRoot();
    writePendingReviewFeedback(root, ISSUE, 'feedback');
    writeHandoffIfPresent(root, ISSUE, 'new note');
    expect(readPendingReviewFeedback(root, ISSUE)).toBe('feedback');
    expect(readHandoff(root, ISSUE)).toBe('new note');
  });

  it('overwrites previous pending feedback on rewrite', () => {
    const root = makeTempRoot();
    writePendingReviewFeedback(root, ISSUE, 'round 1 feedback');
    writePendingReviewFeedback(root, ISSUE, 'round 2 feedback');
    expect(readPendingReviewFeedback(root, ISSUE)).toBe('round 2 feedback');
  });

  it('clearPendingReviewFeedback removes only the transient section', () => {
    const root = makeTempRoot();
    writeHandoffIfPresent(root, ISSUE, 'durable note');
    writePendingReviewFeedback(root, ISSUE, 'feedback');
    clearPendingReviewFeedback(root, ISSUE);

    expect(readPendingReviewFeedback(root, ISSUE)).toBeNull();
    expect(readHandoff(root, ISSUE)).toBe('durable note');
    expect(readFileSync(handoffPath(root, ISSUE), 'utf8')).not.toContain('Pending review feedback');
  });

  it('clearPendingReviewFeedback is a no-op when nothing is pending', () => {
    const root = makeTempRoot();
    clearPendingReviewFeedback(root, ISSUE);
    expect(existsSync(handoffPath(root, ISSUE))).toBe(false);

    writeHandoffIfPresent(root, ISSUE, 'note');
    clearPendingReviewFeedback(root, ISSUE);
    expect(readHandoff(root, ISSUE)).toBe('note');
  });
});

describe('parseHandoffNote', () => {
  it('extracts the ## Loop handoff block from agent result text', () => {
    const text = [
      'All done.',
      '',
      '## Loop commit',
      'type: feat',
      'summary: add parser',
      '',
      '## Loop handoff',
      'Parser lives in src/parser.ts; edge cases in parser.test.ts.',
    ].join('\n');
    expect(parseHandoffNote(text)).toBe('Parser lives in src/parser.ts; edge cases in parser.test.ts.');
  });

  it('returns null when there is no handoff block', () => {
    expect(parseHandoffNote('No blocks here.')).toBeNull();
  });

  it('stops at the next ## heading', () => {
    const text = ['## Loop handoff', 'the note', '', '## Something else', 'ignored'].join('\n');
    expect(parseHandoffNote(text)).toBe('the note');
  });
});

describe('archiveAndClearHandoff', () => {
  it('copies the full content (notes + pending) to the archive path, then empties the file', () => {
    const root = makeTempRoot('loop-handoff-');
    writeHandoffIfPresent(root, ISSUE, 'Durable note.');
    writePendingReviewFeedback(root, ISSUE, 'Blocking verdict body.');

    const archivePath = path.join(root, '.loop', 'runs', 'PRD-006', 'run-1', 'handoff.md');
    archiveAndClearHandoff(root, ISSUE, archivePath);

    const archived = readFileSync(archivePath, 'utf8');
    expect(archived).toContain('Durable note.');
    expect(archived).toContain('Blocking verdict body.');
    expect(readHandoff(root, ISSUE)).toBeNull();
    expect(readPendingReviewFeedback(root, ISSUE)).toBeNull();
  });

  it('archives nothing for an empty or missing handoff, but still clears', () => {
    const root = makeTempRoot('loop-handoff-');
    const archivePath = path.join(root, '.loop', 'runs', 'PRD-006', 'run-1', 'handoff.md');
    archiveAndClearHandoff(root, ISSUE, archivePath);
    expect(existsSync(archivePath)).toBe(false);
  });
});
