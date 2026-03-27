

import type { ConfigCliOverrides } from '../config/load-config.js';
import { type AgentCli, type UsageLimitPolicy } from '../config/types.js';

export const SUBCOMMANDS = ['run', 'review', 'fix-nits', 'polish', 'archive', 'goal', 'goals', 'init', 'list-runs', 'completion'] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export const COMPLETION_SHELLS = ['bash', 'zsh'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export type RunFlags = {
  /** Optional positional: constrain the loop to one feature/PRD project. */
  project: string | null;
  once: boolean;
  dryRun: boolean;
  unblock: boolean;
  maxIterations: number;
  /**
   * Dollar cap on cumulative *reported* spend this invocation — checked before
   * each claim, so an in-flight issue always finishes. CLIs that report no
   * cost (codex/cursor/copilot) are invisible to the cap (loop warns).
   */
  budgetUsd: number | null;
  /** Hide the live agent stream (heartbeats only). */
  quiet: boolean;
  help: boolean;
  config: ConfigCliOverrides;
};

export type FixNitsFlags = {
  dryRun: boolean;
  quiet: boolean;
  help: boolean;
  config: ConfigCliOverrides;
};

export type PolishFlags = {
  /** Positional: the project to polish (nits batch + notes distillation). */
  project: string | null;
  dryRun: boolean;
  quiet: boolean;
  help: boolean;
  config: ConfigCliOverrides;
};

export type ArchiveFlags = {
  /** Positional: the wrapped-up project to archive. */
  project: string | null;
  dryRun: boolean;
  help: boolean;
  config: ConfigCliOverrides;
};

export type GoalFlags = {
  /** Positional: goal text, or an existing slug to resume. */
  text: string | null;
  /** Explicit slug for a new goal (otherwise derived from the text). */
  name: string | null;
  /** Read the goal text from a file. */
  file: string | null;
  /** Rounds this invocation may run (overrides config `goal.roundLimit`). */
  roundLimit: number | null;
  budgetUsd: number | null;
  /** Per-invocation usage-limit policy overrides (beat `goal.usageLimits` and `usageLimits`). */
  onSessionLimit: UsageLimitPolicy | null;
  onWeeklyLimit: UsageLimitPolicy | null;
  /** Max replacements per lineage (overrides config `goal.supersedeLimit`). */
  supersedeLimit: number | null;
  dryRun: boolean;
  quiet: boolean;
  help: boolean;
  config: ConfigCliOverrides;
};

export type ReviewFlags = {
  fix: boolean;
  until: string | null;
  ids: string[];
  file: string | null;
  dryRun: boolean;
  quiet: boolean;
  help: boolean;
  config: ConfigCliOverrides;
};

export type InitFlags = {
  /** Force the guided flow even without a TTY (answers can be piped). */
  interactive: boolean;
  /** Skip the repo-discovery agent session. */
  noDiscovery: boolean;
  agentCli?: AgentCli;
  verifyCmd?: string;
  issuesDir?: string;
  prdsDir?: string;
  /** Optional projects.<name> entry to add. */
  project?: string;
  projectVerifyCmd?: string;
  projectPrd?: string;
  quiet: boolean;
  help: boolean;
};

export type ParsedCli =
  | { command: 'run'; flags: RunFlags }
  | { command: 'review'; flags: ReviewFlags }
  | { command: 'fix-nits'; flags: FixNitsFlags }
  | { command: 'polish'; flags: PolishFlags }
  | { command: 'archive'; flags: ArchiveFlags }
  | { command: 'goal'; flags: GoalFlags }
  | { command: 'goals'; help: boolean }
  | { command: 'init'; flags: InitFlags }
  | { command: 'list-runs'; help: boolean }
  | { command: 'completion'; shell: CompletionShell | null; help: boolean }
  | { command: '__complete'; words: string[] }
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'unknown'; name: string };

/** Flags shared by `run` and `review` that map straight onto config fields. */
const CONFIG_VALUE_FLAGS = new Set([
  '--model',
  '--effort',
  '--agent-cli',
  '--verify-cmd',
  '--issues-dir',
  '--agent-timeout-ms',
  '--agent-idle-timeout-ms',
  '--heartbeat-interval-ms',
  '--max-review-rounds',
  '--max-review-cycles',
  '--max-verify-cycles',
  '--max-verify-fix-cycles',
  '--max-parallel-runs',
]);

const CONFIG_BOOLEAN_FLAGS = new Set(['--no-thinking', '--no-worktree', '--no-caffeinate']);

export const RUN_FLAG_NAMES = [
  '--once',
  '--dry-run',
  '--unblock',
  '--max-iterations',
  '--budget',
  ...CONFIG_VALUE_FLAGS,
  ...CONFIG_BOOLEAN_FLAGS,
  '--quiet',
  '--help',
].sort();
