/**
 * Invocation log: tee everything loop prints to
 * `.loop/logs/<timestamp>-<command>.log`, so cost totals, usage-limit waits,
 * and escalation notices survive a closed terminal window. Wrapping the raw
 * `process.stdout/stderr.write` methods captures every sink (console.* routes
 * through them); the file copy is ANSI-stripped and appended synchronously so
 * a crash loses at most the in-flight line.
 *
 * Lines are stamped `HH:MM:SS` in local time. The interesting question about an
 * autonomous run is "where did the time go?", which a wall-clock reading
 * answers at a glance; the full date would cost a quarter of the line to say
 * something the file's own header already states once.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { loopDir } from '../shared/paths.js';

/** CSI sequences and bare escapes — the file should read like plain text. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b./g;

/** `HH:MM:SS` in local time — the operator's clock, not UTC. */
function formatClock(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

export function invocationLogsDir(root: string): string {
  return path.join(loopDir(root), 'logs');
}

type InvocationLogOptions = {
  now?: () => Date;
};

function timestampChunk(
  chunk: unknown,
  state: { atLineStart: boolean },
  now: () => Date,
): string | Buffer | null {
  if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) return null;
  const text = chunk.toString();
  let formatted = '';

  for (const character of text) {
    if (state.atLineStart && character !== '\n') {
      formatted += `${formatClock(now())} `;
      state.atLineStart = false;
    }
    formatted += character;
    if (character === '\n') state.atLineStart = true;
  }

  return formatted;
}

/**
 * Starts teeing this process's stdout/stderr to a fresh invocation log file.
 * Returns the log path and a `stop` restoring the original writers (tests;
 * normal runs just exit). Write failures disable the tee rather than break
 * the run — the log is an audit convenience, never load-bearing.
 */
export function startInvocationLog(
  root: string,
  command: string,
  options: InvocationLogOptions = {},
): { logPath: string; stop: () => void } {
  const now = options.now ?? (() => new Date());
  const dir = invocationLogsDir(root);
  mkdirSync(dir, { recursive: true });
  const startedAt = now();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 17);
  const logPath = path.join(dir, `${stamp}-${command}.log`);

  let broken = false;
  const append = (chunk: unknown): void => {
    if (broken || typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) return;
    try {
      appendFileSync(logPath, chunk.toString().replace(ANSI_RE, ''));
    } catch {
      broken = true;
    }
  };

  appendFileSync(
    logPath,
    `# loop ${command} — started ${startedAt.toISOString()}\n# argv: ${process.argv.slice(2).join(' ')}\n\n`,
  );

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutState = { atLineStart: true };
  const stderrState = { atLineStart: true };
  process.stdout.write = ((chunk: never, ...rest: never[]) => {
    const formatted = timestampChunk(chunk, stdoutState, now);
    if (formatted === null) return originalStdoutWrite(chunk, ...rest);
    append(formatted);
    return originalStdoutWrite(formatted, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: never, ...rest: never[]) => {
    const formatted = timestampChunk(chunk, stderrState, now);
    if (formatted === null) return originalStderrWrite(chunk, ...rest);
    append(formatted);
    return originalStderrWrite(formatted, ...rest);
  }) as typeof process.stderr.write;

  return {
    logPath,
    stop: () => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}
