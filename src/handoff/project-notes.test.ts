import { readFileSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDirs, makeTempRoot } from '../issues/test-helpers.js';
import { ensureProjectNotes, projectNotesPath } from './project-notes.js';

afterEach(() => {
  cleanupTempDirs();
});

describe('ensureProjectNotes', () => {
  it('seeds the notes file once and never overwrites existing content', () => {
    const root = makeTempRoot('loop-notes-');
    const first = ensureProjectNotes(root, 'PRD-006');
    expect(first).toBe(projectNotesPath(root, 'PRD-006'));
    expect(readFileSync(first, 'utf8')).toContain('# Loop notes — PRD-006');

    writeFileSync(first, 'hand-written wisdom\n');
    expect(ensureProjectNotes(root, 'PRD-006')).toBe(first);
    expect(readFileSync(first, 'utf8')).toBe('hand-written wisdom\n');
  });
});
