import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTempDirs, makeTempRoot } from '../issues/test-helpers.js';
import { contentWidth } from '../logs/output-prefix.js';
import { setColorEnabled } from '../logs/style.js';
import {
  announceDeclaredVerifyCmd,
  declaredVerifyPath,
  ensureDeclaredVerifyDir,
  parseDeclaredVerifyCmd,
  readDeclaredVerifyCmd,
  resolveDeclaredVerifyCmd,
  writeDeclaredVerifyCmd,
} from './declared-verify.js';

afterEach(cleanupTempDirs);

const CONFIGURED = 'npm test';

describe('parseDeclaredVerifyCmd', () => {
  it('takes the first real line, ignoring blanks and the agent’s own commentary', () => {
    expect(parseDeclaredVerifyCmd('\n# chosen because packages/db is new\n\nnpm test -- packages/db\n')).toBe(
      'npm test -- packages/db',
    );
  });

  it('is null when the file holds nothing runnable', () => {
    expect(parseDeclaredVerifyCmd('')).toBeNull();
    expect(parseDeclaredVerifyCmd('# only a comment\n')).toBeNull();
  });
});

describe('declaration storage', () => {
  it('lives under the main .loop/, never inside a worktree', () => {
    const root = makeTempRoot('loop-declared-');
    // A session writing inside the tree after proving the gate would retract
    // its own in-session verify evidence.
    expect(declaredVerifyPath(root, 'PRD-006', 'issue-01')).toBe(
      path.join(root, '.loop', 'verify', 'PRD-006', 'issue-01.cmd'),
    );
  });

  it('round-trips a written declaration', () => {
    const root = makeTempRoot('loop-declared-');
    writeDeclaredVerifyCmd(root, 'PRD-006', 'issue-01', 'npm test -- packages/db');
    expect(readDeclaredVerifyCmd(root, 'PRD-006', 'issue-01')).toBe('npm test -- packages/db');
  });

  it('creates the directory a session is told to write into', () => {
    const root = makeTempRoot('loop-declared-');
    expect(existsSync(ensureDeclaredVerifyDir(root, 'PRD-006'))).toBe(true);
  });

  it('reads as null when no session declared anything', () => {
    const root = makeTempRoot('loop-declared-');
    expect(readDeclaredVerifyCmd(root, 'PRD-006', 'issue-01')).toBeNull();
  });
});

describe('resolveDeclaredVerifyCmd', () => {
  function resolved(root: string, allowed: boolean) {
    return resolveDeclaredVerifyCmd({
      root,
      project: 'PRD-006',
      issueId: 'issue-01',
      configuredCmd: CONFIGURED,
      allowed,
    });
  }

  it('ignores a declaration entirely when the project has not opted in', () => {
    const root = makeTempRoot('loop-declared-');
    writeDeclaredVerifyCmd(root, 'PRD-006', 'issue-01', 'true');
    // Authority over a human-approved gate is never granted by accident.
    expect(resolved(root, false)).toEqual({ cmd: CONFIGURED, declared: false, source: null });
  });

  it('uses the configured command until a session replaces it', () => {
    const root = makeTempRoot('loop-declared-');
    expect(resolved(root, true)).toEqual({ cmd: CONFIGURED, declared: false, source: null });
  });

  it('applies a replacement once one is declared, naming the file it came from', () => {
    const root = makeTempRoot('loop-declared-');
    writeDeclaredVerifyCmd(root, 'PRD-006', 'issue-01', 'npm test -- packages/db');
    expect(resolved(root, true)).toEqual({
      cmd: 'npm test -- packages/db',
      declared: true,
      // Repo-relative: the operator reads the session's own `#` commentary there.
      source: path.join('.loop', 'verify', 'PRD-006', 'issue-01.cmd'),
    });
  });

  it('does not call a declaration identical to the configured command a replacement', () => {
    const root = makeTempRoot('loop-declared-');
    writeDeclaredVerifyCmd(root, 'PRD-006', 'issue-01', CONFIGURED);
    expect(resolved(root, true)).toEqual({ cmd: CONFIGURED, declared: false, source: null });
  });

  it('re-reads per call, so a fix session can correct a wrong choice', () => {
    const root = makeTempRoot('loop-declared-');
    writeDeclaredVerifyCmd(root, 'PRD-006', 'issue-01', 'true');
    expect(resolved(root, true).cmd).toBe('true');
    writeDeclaredVerifyCmd(root, 'PRD-006', 'issue-01', 'npm test -- packages/db');
    expect(resolved(root, true).cmd).toBe('npm test -- packages/db');
  });
});

describe('announceDeclaredVerifyCmd', () => {
  // Assert on the text and its width, not on escape codes.
  beforeEach(() => setColorEnabled(false));
  afterEach(() => setColorEnabled(null));

  const REPLACEMENT = {
    cmd: 'npm test -- db',
    declared: true,
    source: '.loop/verify/PRD-006/issue-01.cmd',
  };

  function captureAnnouncement(resolution = REPLACEMENT, announced = new Set<string>()): string[] {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      announceDeclaredVerifyCmd('[01|verify]', resolution, CONFIGURED, announced);
      return log.mock.calls.map((call) => String(call[0]));
    } finally {
      log.mockRestore();
    }
  }

  it('shows both commands and where the replacement came from', () => {
    const said = captureAnnouncement().join('\n');

    // Fence 4: never silent, and comparable — the configured command sits
    // directly above the one standing in for it.
    expect(said).toContain('VERIFY COMMAND REPLACED');
    expect(said).toContain(`configured ${CONFIGURED}`);
    expect(said).toContain(`declared   ${REPLACEMENT.cmd}`);
    expect(said).toContain(`source     ${REPLACEMENT.source}`);
    expect(said).toContain('post-merge verification runs the configured command');
  });

  it('announces a replacement once, not once per verify cycle', () => {
    const announced = new Set<string>();
    expect(captureAnnouncement(REPLACEMENT, announced).length).toBeGreaterThan(0);
    expect(captureAnnouncement(REPLACEMENT, announced)).toEqual([]);
  });

  it('says nothing when no replacement happened', () => {
    expect(captureAnnouncement({ cmd: CONFIGURED, declared: false, source: null })).toEqual([]);
  });

  it('wraps a long command under its label instead of past the line', () => {
    const long = `pnpm nx run-many -t test --projects=${'pkg-a '.repeat(60)}`;
    const lines = captureAnnouncement({ ...REPLACEMENT, cmd: long });

    // A monorepo's real gate is far longer than a line, and it has to stay
    // comparable with the configured one above it — so it hangs under its own
    // label rather than running off the right edge.
    expect(lines.length).toBeGreaterThan(captureAnnouncement().length);
    // `contentWidth('')` is the whole line minus the invocation log's stamp.
    const budget = contentWidth('');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(budget);
  });
});
