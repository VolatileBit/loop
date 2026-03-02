/**
 * In-session verify evidence: decides when an agent session has *proven* the
 * external verify command in its own stream, so the runner can skip its
 * duplicate re-run (see verify/run-verify.ts `maybeSkipVerify`).
 *
 * Pure, no I/O. run-agent.ts feeds one tracker per session, in stream order:
 * `observeToolUse(name, input)` for every tool call and `observeExec(command,
 * ok)` for every harness-recorded shell outcome. A command counts as proven
 * only when it succeeded *and* nothing that could change the tree ran after it.
 *
 * Conservative by construction: a wrong decision can only ever *run* the
 * verify redundantly, never skip it wrongly. Known limitation: a pre-commit
 * hook that mutates files stales evidence undetected — hooks whose fixers
 * mirror the verify are safe in practice (a passing verify leaves them nothing
 * to fix).
 */

import path from 'node:path';

export type EvidenceTracker = {
  observeToolUse(name: string, input: Record<string, unknown>): void;
  observeExec(command: string, ok: boolean): void;
  /** Commands proven successful with no tree-affecting observation after them. */
  provenCommands(): string[];
};

/**
 * Git bookkeeping that provably leaves the working tree alone. `add|commit`
 * are included on purpose: the post-verify workflow is exactly "run verify,
 * stage, commit" — excluding them would retract evidence at the last step of
 * every session.
 */
const SAFE_GIT_RE = /^\s*git\s+(status|diff|log|show|rev-parse|branch|add|commit|worktree\s+list)\b/;

/** Shell metacharacters that can smuggle arbitrary commands past SAFE_GIT_RE. */
const SHELL_META_RE = /[;|<>`]|\$\(/;

/**
 * Read-only tool vocabulary across the supported CLIs: Claude Code names,
 * codex item types, cursor `<name>ToolCall` keys. TodoWrite/todo_list write
 * agent-internal state, not the repo tree.
 */
const READ_ONLY_TOOLS = new Set([
  // claude-code
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoRead',
  'TodoWrite',
  'BashOutput',
  'WebFetch',
  'WebSearch',
  'Skill',
  // codex
  'web_search',
  'todo_list',
  // cursor
  'read',
  'grep',
  'glob',
  'ls',
]);

/**
 * File-writing tools whose targets we can check against the worktree root:
 * Claude Code editors, codex `file_change`, cursor `edit`/`write`, copilot
 * `create`/`edit`. An absolute target wholly outside the worktree cannot
 * affect the verify outcome (loop bookkeeping lives out-of-tree).
 */
const PATH_WRITE_TOOLS = new Set([
  // claude-code
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  // codex
  'file_change',
  // cursor + copilot
  'edit',
  'write',
  'create',
]);

/** Input keys that may carry a write target (string or string[]). */
const WRITE_TARGET_KEYS = ['file_path', 'notebook_path', 'path', 'paths'] as const;

function writeTargets(input: Record<string, unknown>): string[] | null {
  const targets: string[] = [];
  for (const key of WRITE_TARGET_KEYS) {
    const value = input[key];
    if (typeof value === 'string') targets.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== 'string') return null;
        targets.push(item);
      }
    } else if (value !== undefined) {
      return null;
    }
  }
  return targets.length > 0 ? targets : null;
}

function isOutsideRoot(target: string, root: string): boolean {
  // Relative paths resolve against the worktree cwd — never safely outside.
  if (!path.isAbsolute(target)) return false;
  const relative = path.relative(root, target);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

/** True when every `&&`-chained segment is tree-safe git bookkeeping. */
function isSafeGitOnlyCommand(command: string): boolean {
  if (SHELL_META_RE.test(command)) return false;
  return command.split('&&').every((segment) => SAFE_GIT_RE.test(segment));
}

export type EvidenceTrackerOptions = {
  /** The session's working tree root; unset disables the out-of-tree write exemption. */
  worktreeRoot?: string | null;
};

export function createEvidenceTracker(options: EvidenceTrackerOptions = {}): EvidenceTracker {
  const worktreeRoot = options.worktreeRoot ?? null;
  let seq = 0;
  let lastInvalidatingSeq = -1;
  const successes = new Map<string, number>();

  const isSafeToolUse = (name: string, input: Record<string, unknown>): boolean => {
    // Any shell-type call (whatever the tool is named) is judged by its command.
    const command = input.command;
    if (typeof command === 'string') return isSafeGitOnlyCommand(command);

    if (READ_ONLY_TOOLS.has(name)) return true;

    if (PATH_WRITE_TOOLS.has(name) && worktreeRoot) {
      const targets = writeTargets(input);
      if (targets) return targets.every((target) => isOutsideRoot(target, worktreeRoot));
    }

    // Unknown tools, MCP tools, Task, in-tree writes: assume the tree changed.
    return false;
  };

  return {
    observeToolUse(name, input) {
      seq += 1;
      if (!isSafeToolUse(name, input)) lastInvalidatingSeq = seq;
    },

    observeExec(command, ok) {
      seq += 1;
      const key = command.trim();
      if (!key) return;
      if (ok) successes.set(key, seq);
      else successes.delete(key); // a later failure retracts the earlier pass
    },

    provenCommands() {
      return [...successes.entries()]
        .filter(([, at]) => at > lastInvalidatingSeq)
        .map(([command]) => command);
    },
  };
}

/**
 * Does the proven-command set satisfy `verifyCmd`? Exact trim match, or —
 * because sessions often run a multi-part verify as separate commands during
 * the work — every `&&` segment individually proven (segment proof is equally
 * strong: proven entries already have clean tails).
 */
export function isProven(proven: readonly string[], verifyCmd: string): boolean {
  const provenSet = new Set(proven.map((command) => command.trim()));
  if (provenSet.has(verifyCmd.trim())) return true;

  const segments = verifyCmd.split('&&').map((segment) => segment.trim());
  if (segments.length < 2) return false;
  return segments.every((segment) => segment.length > 0 && provenSet.has(segment));
}
