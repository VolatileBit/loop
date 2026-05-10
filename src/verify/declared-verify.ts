/**
 * The declared-verify contract in **project mode**.
 *
 * A project's `verifyCmd` is frozen at setup time, but what actually needs
 * proving is often not knowable then: a new feature grows a service, a package,
 * a migration, and the gate that was right on day one silently stops covering
 * the code being written. So a session may *replace* the command for one issue,
 * by writing it to `.loop/verify/<project>/<issue-id>.cmd`.
 *
 * This is a real transfer of authority over a human-approved gate, so it is
 * off by default (`allowDeclaredVerify`) and fenced on four sides:
 *
 * 1. The implement prompt frames replacement as the exception, and names
 *    weakening the gate a blocking review finding.
 * 2. The review sees the configured and declared commands side by side, and is
 *    told to block on a replacement that is merely easier to pass.
 * 3. Post-merge verification always runs the **configured** command, so a
 *    narrowed gate cannot shrink what the merged tree is held to.
 * 4. Every replacement is printed. Nothing is applied silently.
 *
 * Declarations live under the main repo's `.loop/`, never inside a worktree:
 * a session writing there would otherwise retract its own in-session verify
 * evidence by touching the tree after proving the gate.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { contentWidth, prefixWidth, wrapToWidth } from '../logs/output-prefix.js';
import { badge, detail } from '../logs/style.js';
import { loopDir } from '../shared/paths.js';

/** `.loop/verify/<project>/` — one `.cmd` file per issue that declared one. */
export function declaredVerifyDir(root: string, project: string): string {
  return path.join(loopDir(root), 'verify', project);
}

export function declaredVerifyPath(root: string, project: string, issueId: string): string {
  return path.join(declaredVerifyDir(root, project), `${issueId}.cmd`);
}

/**
 * The command from a declaration file's contents: the first non-empty,
 * non-comment line, so a trailing newline or an explanatory `#` line from the
 * agent doesn't break it. Shared with goal mode, which uses the same format.
 */
export function parseDeclaredVerifyCmd(raw: string): string | null {
  const line = raw
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith('#'));
  return line ?? null;
}

/** The declared command for one issue, or null when it declared none. */
export function readDeclaredVerifyCmd(root: string, project: string, issueId: string): string | null {
  try {
    return parseDeclaredVerifyCmd(readFileSync(declaredVerifyPath(root, project, issueId), 'utf8'));
  } catch {
    return null;
  }
}

/** Create the directory a session is told to write its declaration into. */
export function ensureDeclaredVerifyDir(root: string, project: string): string {
  const dir = declaredVerifyDir(root, project);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Test/setup helper: write a declaration exactly as a session would. */
export function writeDeclaredVerifyCmd(
  root: string,
  project: string,
  issueId: string,
  cmd: string,
): void {
  ensureDeclaredVerifyDir(root, project);
  writeFileSync(declaredVerifyPath(root, project, issueId), `${cmd}\n`);
}

export type VerifyCmdResolution = {
  /** The command that will actually gate this issue. */
  cmd: string;
  /** True when a session's declaration replaced the configured command. */
  declared: boolean;
  /**
   * Repo-relative path of the declaration file, or null when nothing was
   * declared. Printed with the replacement: the file also holds whatever `#`
   * commentary the session wrote, which is where an operator reads *why*.
   */
  source: string | null;
};

/**
 * Resolve the gate for one issue. Re-read per call, never cached: a fix session
 * may correct a wrong declaration mid-issue, and — more importantly — the
 * evidence-based skip must always compare against the *current* command, so a
 * session that proved the old one and then replaced it fails the evidence test
 * and gets a real run.
 */
export function resolveDeclaredVerifyCmd(options: {
  root: string;
  project: string;
  issueId: string;
  /** The project's configured command — the fallback, and what post-merge always runs. */
  configuredCmd: string;
  /** Off by default; a project opts in via `allowDeclaredVerify`. */
  allowed: boolean;
}): VerifyCmdResolution {
  if (!options.allowed) return { cmd: options.configuredCmd, declared: false, source: null };
  const declared = readDeclaredVerifyCmd(options.root, options.project, options.issueId);
  if (!declared || declared === options.configuredCmd) {
    return { cmd: options.configuredCmd, declared: false, source: null };
  }
  return {
    cmd: declared,
    declared: true,
    source: path.relative(options.root, declaredVerifyPath(options.root, options.project, options.issueId)),
  };
}

/** Widest field label below; the values line up one column past it. */
const FIELD_LABEL_WIDTH = 'configured'.length;

/**
 * Fence 4: a replacement is always announced, so it can never be applied
 * silently.
 *
 * Both commands are printed in full, one above the other, because the question
 * an operator has is what *changed* — a replacement that quietly drops a
 * package from the gate differs from the configured command by a few words in
 * the middle of a long line, and is invisible unless the two can be compared.
 */
export function announceDeclaredVerifyCmd(
  prefix: string,
  resolution: VerifyCmdResolution,
  configuredCmd: string,
  announced: Set<string>,
): void {
  if (!resolution.declared || announced.has(resolution.cmd)) return;
  announced.add(resolution.cmd);

  // Continuation lines hold the prefix's column and indent past the badge, as
  // the agent rail's continuations do.
  const indent = `${' '.repeat(prefixWidth(prefix))}   `;
  const width = contentWidth(prefix, 3 + FIELD_LABEL_WIDTH + 1);

  const field = (label: string, value: string): void => {
    wrapToWidth(value, width).forEach((line, index) => {
      // The label is written once and its column held below, so a wrapped
      // command stays one readable block rather than a stutter of labels.
      const head = index === 0 ? detail(label.padEnd(FIELD_LABEL_WIDTH)) : ' '.repeat(FIELD_LABEL_WIDTH);
      console.log(`${indent}${head} ${line}`);
    });
  };

  console.log(`${prefix} ${badge('VERIFY COMMAND REPLACED', 'caution')}`);
  field('configured', configuredCmd);
  field('declared', resolution.cmd);
  if (resolution.source) field('source', resolution.source);
  console.log(`${indent}${detail('post-merge verification runs the configured command.')}`);
}
