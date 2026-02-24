/**
 * In-session verify evidence: decides when an agent session has *proven* the
 * external verify command in its own stream, so the runner can skip its.
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
