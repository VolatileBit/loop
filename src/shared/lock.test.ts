import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireInvocationLock, lockPath } from './lock.js';

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-lock-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('acquireInvocationLock', () => {
  it('writes the pid file and removes it on release', () => {
    const root = tempRoot();
    const release = acquireInvocationLock(root);
    const holder = JSON.parse(readFileSync(lockPath(root), 'utf8')) as { pid: number };
    expect(holder.pid).toBe(process.pid);
    release();
    expect(existsSync(lockPath(root))).toBe(false);
  });

  it('throws while another live process holds the lock', () => {
    const root = tempRoot();
    mkdirSync(path.dirname(lockPath(root)), { recursive: true });
    // ppid is a live process that is not us.
    writeFileSync(lockPath(root), JSON.stringify({ pid: process.ppid }));
    expect(() => acquireInvocationLock(root)).toThrow(/already running/);
  });

  it('takes over stale locks (dead pid or corrupt file)', () => {
    const root = tempRoot();
    mkdirSync(path.dirname(lockPath(root)), { recursive: true });
    writeFileSync(lockPath(root), JSON.stringify({ pid: 99999999 }));
    const release = acquireInvocationLock(root);
    expect(JSON.parse(readFileSync(lockPath(root), 'utf8'))).toMatchObject({ pid: process.pid });
    release();

    writeFileSync(lockPath(root), 'not json');
    const release2 = acquireInvocationLock(root);
    release2();
  });
});
