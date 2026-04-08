import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  activeChildCount,
  killAllActiveChildren,
  killProcessTree,
  registerActiveChild,
  unregisterActiveChild,
} from './shutdown.js';

function sleepChild(ms: number): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], {
    detached: true,
    stdio: 'ignore',
  });
}

const tracked: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  killAllActiveChildren('SIGKILL');
  for (const child of tracked) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already exited
    }
  }
  tracked.length = 0;
});

describe('active child registry', () => {
  it('tracks register/unregister and reports activeChildCount', () => {
    const child = sleepChild(30_000);
    tracked.push(child);
    expect(activeChildCount()).toBe(0);

    registerActiveChild(child);
    expect(activeChildCount()).toBe(1);

    unregisterActiveChild(child);
    expect(activeChildCount()).toBe(0);
  });
});

describe('killProcessTree', () => {
  it('terminates a live child process', async () => {
    const child = sleepChild(60_000);
    tracked.push(child);
    registerActiveChild(child);

    expect(child.pid).toBeGreaterThan(0);
    killProcessTree(child, 'SIGTERM');

    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(exited).toBe(true);
    unregisterActiveChild(child);
  });
});

describe('killAllActiveChildren', () => {
  it('kills every registered child', async () => {
    const first = sleepChild(60_000);
    const second = sleepChild(60_000);
    tracked.push(first, second);
    registerActiveChild(first);
    registerActiveChild(second);
    expect(activeChildCount()).toBe(2);

    killAllActiveChildren('SIGTERM');

    const bothExited = await Promise.all(
      [first, second].map(
        (child) =>
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 3000);
            child.on('exit', () => {
              clearTimeout(timer);
              resolve(true);
            });
          }),
      ),
    );
    expect(bothExited).toEqual([true, true]);
    expect(activeChildCount()).toBe(2);
    unregisterActiveChild(first);
    unregisterActiveChild(second);
    expect(activeChildCount()).toBe(0);
  });
});
