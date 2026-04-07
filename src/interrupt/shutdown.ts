/**
 * Process-wide shutdown wiring: signal/keypress handlers, the active-child
 * registry, and the failStop banner.
 *
 * Unlike the original scripts implementation (one global `activeAgentChild`),
 * this maintains a *registry* of active agent children so a force-stop kills
 * every parallel worker's child process tree, not just one.
 */

import { spawnSync, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

import { bad, caution, detail } from '../logs/style.js';
import {
  handleCtrlCPress,
  handleEscPress,
  initialInterruptState,
  type InterruptState,
} from './state-machine.js';

const activeChildren = new Set<ChildProcess>();
let shuttingDown = false;
let parkRequested = false;

/** Track a spawned agent child so shutdown/force-stop can kill it. */
export function registerActiveChild(child: ChildProcess): void {
  activeChildren.add(child);
}

export function unregisterActiveChild(child: ChildProcess): void {
  activeChildren.delete(child);
}

export function activeChildCount(): number {
  return activeChildren.size;
}

/** True once a force-stop/terminal signal has begun tearing the process down. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * True once ESC has been pressed twice: the pipeline should stop at its next
 * stage boundary and park the in-flight issue. Module-level (like
 * `isShuttingDown`) because every stage boundary in the pipeline and its fix
 * loops consults it, and threading a flag through all of them would say
 * nothing extra.
 */
export function isParkRequested(): boolean {
  return parkRequested;
}

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    // Negative pid targets the whole process group (agent CLI + its shell children).
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // process already exited
    }
  }
}

/** Kill every registered active child's process tree. */
export function killAllActiveChildren(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const child of activeChildren) killProcessTree(child, signal);
}

/**
 * Prints a clearly-bordered failure banner and exits. Every non-zero exit path in
 * loop should route through this so a scrollback full of agent chatter still ends
 * with an unmissable, explicit reason for why the loop stopped.
 */
export function failStop(reason: string, options: { code?: number; details?: string[] } = {}): never {
  const code = options.code ?? 1;
  const border = '='.repeat(72);
  console.error(bad(`\n${border}`));
  console.error(bad(`[loop] STOPPED — ${reason}`));
  for (const line of options.details ?? []) console.error(detail(`  ${line}`));
  console.error(bad(border));
  process.exit(code);
}

export type ShutdownCallbacks = {
  /** Called once when a force-stop begins (after SIGTERM is sent to active children), e.g. to record interrupted runs. */
  onForceStop?: () => void;
};

export type ShutdownHandle = {
  /** True after ESC (or first no-TTY SIGINT): finish the current task, then exit. */
  isStopRequested(): boolean;
  /** True after a second ESC: stop at the next stage boundary, parking the in-flight issue. */
  isParkRequested(): boolean;
  isShuttingDown(): boolean;
};

/**
 * Wires up loop's two interrupt gestures:
 *  - ESC: idempotent graceful stop — finish the current task, then exit before the
 *    next issue/stage. Safe to press repeatedly; each press just re-confirms.
 *  - Ctrl+C x2 (any time during the run): immediate force-stop, killing every active
 *    agent process tree. A single Ctrl+C only warns, to guard against accidental exits.
 *
 * ESC has no signal of its own, so detecting it requires raw-mode stdin keypress
 * events (only available on an interactive TTY). When stdin isn't a TTY (piped,
 * CI, backgrounded), we fall back to treating the first SIGINT as the graceful-stop
 * request and the second as the force-stop, preserving a usable stop mechanism.
 */
export function registerShutdownHandlers(callbacks: ShutdownCallbacks = {}): ShutdownHandle {
  let interruptState: InterruptState = initialInterruptState();

  const shutdown = (signal: NodeJS.Signals, exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`\n[loop] received ${signal}, stopping agent and child processes…`);
    killAllActiveChildren('SIGTERM');
    callbacks.onForceStop?.();
    setTimeout(() => killAllActiveChildren('SIGKILL'), 3000);
    setTimeout(() => process.exit(exitCode), 500);
  };

  const applyEsc = (): void => {
    if (shuttingDown) return;
    const result = handleEscPress(interruptState);
    interruptState = result.state;
    parkRequested = result.state.parkRequested;
    console.error(caution(`\n${result.message}`));
  };

  const applyCtrlC = (): void => {
    if (shuttingDown) return;
    const result = handleCtrlCPress(interruptState);
    interruptState = result.state;
    console.error(`\n${result.message}`);
    if (result.shouldForceStop) shutdown('SIGINT', 130);
  };

  const isInteractive = process.stdin.isTTY === true;

  if (isInteractive) {
    readline.emitKeypressEvents(process.stdin);
    try {
      process.stdin.setRawMode(true);
    } catch {
      // Some environments report isTTY but don't support raw mode; ESC detection
      // simply won't fire in that case and Ctrl+C still works via SIGINT below.
    }
    process.stdin.on('keypress', (_str: string, key: { name?: string; ctrl?: boolean } | undefined) => {
      if (!key) return;
      if (key.name === 'escape') applyEsc();
      else if (key.ctrl && key.name === 'c') applyCtrlC();
    });
    process.stdin.resume();
    console.log(
      '[loop] press ESC to stop gracefully after the current task, or Ctrl+C twice at any time to force-stop.',
    );
  } else {
    // No TTY means no keypress events, so ESC can't be detected. Preserve a stop
    // mechanism by mapping the first SIGINT to the graceful-stop gesture.
    process.on('SIGINT', () => {
      if (!interruptState.stopRequested) applyEsc();
      else applyCtrlC();
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM', 143));
  process.on('SIGHUP', () => shutdown('SIGHUP', 129));
  process.on('exit', () => {
    killAllActiveChildren('SIGKILL');
  });

  return {
    isStopRequested: () => interruptState.stopRequested,
    isParkRequested: () => interruptState.parkRequested,
    isShuttingDown: () => shuttingDown,
  };
}
