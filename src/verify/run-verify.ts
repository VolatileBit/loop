/**
 * External verification: run the repo's verify command in the work root and
 * summarize failures for the console and fix prompts.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { formatDuration } from '../agent/format.js';
import { isProven } from '../agent/evidence.js';
import { registerActiveChild, unregisterActiveChild } from '../interrupt/shutdown.js';
import { contentWidth, formatOutputPrefix, prefixWidth, wrapToWidth } from '../logs/output-prefix.js';
import { detail } from '../logs/style.js';
import type { ShellResult } from '../shared/shell.js';

export type ShellVerifyResult = ShellResult;

export type VerifyProgressOptions = {
  /** Structured label such as `SPEC-011/issue-01-verify`. */
  stageLabel?: string;
  /** Progress interval while the command remains active. */
  heartbeatIntervalMs?: number;
  /**
   * Environment for the command. Must be the same map the agent sessions got
   * (see resolveProjectEnv) — otherwise a command a session verified by hand
   * behaves differently when loop re-runs it.
   */
  env?: NodeJS.ProcessEnv;
};

const VERIFY_LEAD = 'starting verification: ';

/**
 * Announce the gate about to run, whole. A real monorepo command is longer than
 * a line, and cutting it hides exactly the tail that says which packages are
 * covered — so it wraps under its own column instead, the way a replacement
 * announcement does (see declared-verify.ts).
 */
export function announceVerifyStart(prefix: string, verifyCmd: string): void {
  const hang = ' '.repeat(prefixWidth(prefix) + 1 + VERIFY_LEAD.length);
  wrapToWidth(verifyCmd, contentWidth(prefix, VERIFY_LEAD.length + 1)).forEach((line, index) => {
    console.log(index === 0 ? `${prefix} ${VERIFY_LEAD}${line}` : `${hang}${line}`);
  });
}

/** Run `verifyCmd` in `cwd`, capturing output while reporting live progress. */
export function runVerifyCommand(
  verifyCmd: string,
  cwd: string,
  logPath: string,
  options: VerifyProgressOptions = {},
): Promise<ShellVerifyResult> {
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, '');

  const startedAt = Date.now();
  const prefix = formatOutputPrefix('loop', options.stageLabel ?? 'verify');
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
  announceVerifyStart(prefix, verifyCmd);

  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(verifyCmd, {
      cwd,
      shell: true,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    registerActiveChild(child);

    const capture = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      output += text;
      appendFileSync(logPath, text);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const heartbeat = setInterval(() => {
      // A liveness tick, not news: it says only that nothing has gone wrong yet.
      console.log(`${prefix} ${detail(`verification running… elapsed ${formatDuration(Date.now() - startedAt)}`)}`);
    }, heartbeatIntervalMs);

    const finish = (code: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      unregisterActiveChild(child);
      clearInterval(heartbeat);
      if (error) capture(`\n[loop] verify spawn error: ${error.message}\n`);
      const ok = !error && code === 0;
      console.log(
        `${prefix} verification ${ok ? 'passed' : 'failed'} (${formatDuration(Date.now() - startedAt)}; log: ${logPath})`,
      );
      resolve({ ok, output, code: error ? 1 : code });
    };

    child.on('error', (error) => finish(1, error));
    child.on('close', (code) => finish(code));
  });
}

/**
 * Did the session that just ran already prove this exact verify command
 * in-stream (harness-recorded success, nothing tree-affecting after it)?
 * Callers may then skip the runner's duplicate run — see agent/evidence.ts.
 * Only gates tied to the session that produced the evidence may consult this;
 * the resume-time safety verify and the post-merge verify never do (they gate
 * trees no single session saw).
 */
export function verifySatisfiedInSession(
  provenCommands: readonly string[] | undefined,
  verifyCmd: string,
): boolean {
  return provenCommands !== undefined && provenCommands.length > 0 && isProven(provenCommands, verifyCmd);
}

/**
 * Stand-in result for a skipped duplicate verify: writes the log artifact so
 * the run dir still explains what happened, prints the skip note, and reports
 * success (the evidence *is* a successful execution of the same command).
 */
export function recordSkippedVerify(verifyCmd: string, logPath: string): ShellVerifyResult {
  const output =
    'SKIPPED — the session already ran this exact command to success in-stream, with no ' +
    'tree-affecting tool call after it (harness-recorded evidence, see agent/evidence.ts).\n' +
    `command: ${verifyCmd}\n`;
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, output);
  console.log(`[loop] verify satisfied in-session — skipping duplicate run (${verifyCmd})`);
  return { ok: true, output, code: 0 };
}

/** Pull human-readable failure lines from vitest / pnpm verify output. */
export function extractVerifyFailures(output: string): string[] {
  const failures: string[] = [];
  const seen = new Set<string>();

  const add = (line: string): void => {
    // eslint-disable-next-line no-control-regex -- strips ANSI color codes
    const trimmed = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    failures.push(trimmed);
  };

  for (const line of output.split('\n')) {
    // eslint-disable-next-line no-control-regex -- strips ANSI color codes
    const stripped = line.replace(/\u001b\[[0-9;]*m/g, '');
    if (/^\s*FAIL\s+/.test(stripped)) add(stripped);
    else if (/^\s*×\s+/.test(stripped)) add(stripped);
    else if (/MongoServerError:/.test(stripped)) add(stripped);
    else if (/^\s*AssertionError/.test(stripped)) add(stripped);
    else if (/Test Files\s+.*\d+\s+failed/.test(stripped)) add(stripped);
    else if (/^\s*Tests\s+.*\d+\s+failed/.test(stripped)) add(stripped);
  }

  return failures;
}

export function printVerifyFailureSummary(verify: ShellVerifyResult, maxCycles?: number): void {
  if (maxCycles !== undefined) {
    console.error(
      `\nExternal verification failed after ${maxCycles} verify↔implement fix cycle(s). See verify logs under .loop/runs/.`,
    );
  } else {
    console.error('\nExternal verification failed. See verify.log for full output.');
  }
  const failures = extractVerifyFailures(verify.output);
  if (failures.length > 0) {
    console.error('\nFailure summary:');
    for (const line of failures.slice(0, 8)) {
      console.error(`  ${line}`);
    }
    if (failures.length > 8) {
      console.error(`  … and ${failures.length - 8} more line(s)`);
    }
  }
}
