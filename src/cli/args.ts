/**
 * Subcommand-aware CLI parsing (hand-rolled, no framework — mirrors
 * packages/cli). Config-backed flags parse into ConfigCliOverrides and feed
 * loadConfig(); `--agent-cli`/`--model` additionally feed StageCliFlags for
 * per-stage resolution. Malformed input throws a descriptive Error — bin.ts
 * routes it through failStop.
 */

import path from 'node:path';

import type { ConfigCliOverrides } from '../config/load-config.js';
import { AGENT_CLIS, type AgentCli, type UsageLimitPolicy } from '../config/types.js';
import { EFFORT_LEVELS } from '../config/effort.js';

export const SUBCOMMANDS = ['run', 'review', 'fix-nits', 'polish', 'archive', 'goal', 'goals', 'init', 'install', 'list-runs', 'completion'] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export const COMPLETION_SHELLS = ['bash', 'zsh'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export type RunFlags = {
  /** Optional positional: constrain the loop to one feature/spec project. */
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
  specsDir?: string;
  /** Optional projects.<name> entry to add. */
  project?: string;
  projectVerifyCmd?: string;
  projectSpec?: string;
  quiet: boolean;
  help: boolean;
};

export const PLANNING_SKILL_TARGETS = ['claudecode', 'codexcli', 'cursor', 'copilot'] as const;
export type PlanningSkillTarget = (typeof PLANNING_SKILL_TARGETS)[number];
export type InstallScope = 'project' | 'user';
export type InstallFlags = { targets: PlanningSkillTarget[]; scope?: InstallScope; interactive: boolean; force: boolean; dryRun: boolean; help: boolean };
export const INSTALL_FLAG_NAMES = ['--targets', '--scope', '--interactive', '--force', '--dry-run', '--help'] as const;

export type ParsedCli =
  | { command: 'run'; flags: RunFlags }
  | { command: 'review'; flags: ReviewFlags }
  | { command: 'fix-nits'; flags: FixNitsFlags }
  | { command: 'polish'; flags: PolishFlags }
  | { command: 'archive'; flags: ArchiveFlags }
  | { command: 'goal'; flags: GoalFlags }
  | { command: 'goals'; help: boolean }
  | { command: 'init'; flags: InitFlags }
  | { command: 'install'; flags: InstallFlags }
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

export const FIX_NITS_FLAG_NAMES = ['--dry-run', ...CONFIG_VALUE_FLAGS, ...CONFIG_BOOLEAN_FLAGS, '--quiet', '--help'].sort();

export const POLISH_FLAG_NAMES = FIX_NITS_FLAG_NAMES;

/** Archive takes no --quiet: it prints the plan it is about to execute. */
export const ARCHIVE_FLAG_NAMES = ['--dry-run', ...CONFIG_VALUE_FLAGS, ...CONFIG_BOOLEAN_FLAGS, '--help'].sort();

export const GOAL_FLAG_NAMES = [
  '--name',
  '--file',
  '--round-limit',
  '--budget',
  '--on-session-limit',
  '--on-weekly-limit',
  '--supersede-limit',
  '--dry-run',
  ...CONFIG_VALUE_FLAGS,
  ...CONFIG_BOOLEAN_FLAGS,
  '--quiet',
  '--help',
].sort();

export const INIT_FLAG_NAMES = [
  '--interactive',
  '--no-discovery',
  '--agent-cli',
  '--verify-cmd',
  '--issues-dir',
  '--specs-dir',
  '--project',
  '--project-verify-cmd',
  '--project-spec',
  '--quiet',
  '--help',
].sort();

export const REVIEW_FLAG_NAMES = [
  '--fix',
  '--until',
  '--ids',
  '--file',
  '--dry-run',
  ...CONFIG_VALUE_FLAGS,
  ...CONFIG_BOOLEAN_FLAGS,
  '--quiet',
  '--help',
].sort();

/** Flags that take a value (completion needs to know a value word follows). */
export const VALUE_FLAGS = new Set([
  ...CONFIG_VALUE_FLAGS,
  '--max-iterations',
  '--budget',
  '--until',
  '--ids',
  '--file',
  '--name',
  '--round-limit',
  '--on-session-limit',
  '--on-weekly-limit',
  '--supersede-limit',
  '--specs-dir',
  '--project',
  '--project-verify-cmd',
  '--project-spec',
  '--targets',
  '--scope',
  // Accepted input aliases; help and completion advertise only the spec names.
  '--prds-dir',
  '--project-prd',
]);

/** Enum-valued flags and their fixed candidate sets (for completion). */
export const FLAG_ENUM_VALUES: Record<string, readonly string[]> = {
  '--agent-cli': AGENT_CLIS,
  '--effort': EFFORT_LEVELS,
  '--on-session-limit': ['wait', 'stop'],
  '--on-weekly-limit': ['wait', 'stop'],
};

function parseLimitPolicy(flag: string, raw: string | undefined): UsageLimitPolicy {
  if (raw !== 'wait' && raw !== 'stop') {
    throw new Error(`${flag} must be "wait" or "stop"${raw === undefined ? '' : ` (got "${raw}")`}`);
  }
  return raw;
}

function parsePositiveNumber(flag: string, raw: string | undefined): number {
  if (raw === undefined) throw new Error(`${flag} requires a value`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} must be a positive number (got "${raw}")`);
  }
  return value;
}

function parseAgentCli(raw: string | undefined): AgentCli {
  if (raw === undefined || !(AGENT_CLIS as readonly string[]).includes(raw)) {
    throw new Error(`--agent-cli must be one of: ${AGENT_CLIS.join(', ')} (got "${raw ?? ''}")`);
  }
  return raw as AgentCli;
}

function requireValue(flag: string, raw: string | undefined): string {
  if (raw === undefined || raw.startsWith('--')) throw new Error(`${flag} requires a value`);
  return raw;
}

/**
 * Try to consume a config-backed flag at argv[i]. Returns the next index to
 * continue from, or null when argv[i] is not a config flag.
 */
function consumeConfigFlag(argv: string[], i: number, config: ConfigCliOverrides): number | null {
  const arg = argv[i]!;
  switch (arg) {
    case '--model':
      config.model = requireValue(arg, argv[i + 1]);
      return i + 2;
    case '--effort':
      config.effort = requireValue(arg, argv[i + 1]);
      return i + 2;
    case '--agent-cli':
      config.agentCli = parseAgentCli(argv[i + 1]);
      return i + 2;
    case '--verify-cmd':
      config.verifyCmd = requireValue(arg, argv[i + 1]);
      return i + 2;
    case '--issues-dir':
      config.issuesDir = path.resolve(requireValue(arg, argv[i + 1]));
      return i + 2;
    case '--agent-timeout-ms':
      config.agentTimeoutMs = parsePositiveNumber(arg, argv[i + 1]);
      return i + 2;
    case '--agent-idle-timeout-ms':
      config.agentIdleTimeoutMs = parsePositiveNumber(arg, argv[i + 1]);
      return i + 2;
    case '--heartbeat-interval-ms':
      config.heartbeatIntervalMs = parsePositiveNumber(arg, argv[i + 1]);
      return i + 2;
    case '--max-review-rounds':
    case '--max-review-cycles':
      config.maxReviewCycles = parsePositiveNumber(arg, argv[i + 1]);
      return i + 2;
    case '--max-verify-cycles':
    case '--max-verify-fix-cycles':
      config.maxVerifyCycles = parsePositiveNumber(arg, argv[i + 1]);
      return i + 2;
    case '--max-parallel-runs':
      config.maxParallelRuns = parsePositiveNumber(arg, argv[i + 1]);
      return i + 2;
    case '--no-thinking':
      config.showThinking = false;
      return i + 1;
    case '--no-worktree':
      config.worktreeEnabled = false;
      return i + 1;
    case '--no-caffeinate':
      config.keepAwake = false;
      return i + 1;
    default:
      return null;
  }
}

function defaultQuiet(env: Record<string, string | undefined>): boolean {
  return env.LOOP_QUIET === '1';
}

function parseRunArgs(argv: string[], env: Record<string, string | undefined>): RunFlags {
  const flags: RunFlags = {
    project: null,
    once: false,
    dryRun: false,
    unblock: false,
    maxIterations: Number.POSITIVE_INFINITY,
    budgetUsd: null,
    quiet: defaultQuiet(env),
    help: false,
    config: {},
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    const consumed = consumeConfigFlag(argv, i, flags.config);
    if (consumed !== null) {
      i = consumed;
      continue;
    }
    if (arg === '--once') flags.once = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--unblock') flags.unblock = true;
    else if (arg === '--max-iterations') {
      flags.maxIterations = parsePositiveNumber(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--budget') {
      flags.budgetUsd = parsePositiveNumber(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--quiet') flags.quiet = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown flag for loop run: ${arg}`);
    else if (flags.project === null) flags.project = arg;
    else throw new Error(`Unexpected extra argument for loop run: ${arg} (project already set to "${flags.project}")`);
    i += 1;
  }

  return flags;
}

function parseReviewArgs(argv: string[], env: Record<string, string | undefined>): ReviewFlags {
  const flags: ReviewFlags = {
    fix: false,
    until: null,
    ids: [],
    file: null,
    dryRun: false,
    quiet: defaultQuiet(env),
    help: false,
    config: {},
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    const consumed = consumeConfigFlag(argv, i, flags.config);
    if (consumed !== null) {
      i = consumed;
      continue;
    }
    if (arg === '--fix') flags.fix = true;
    else if (arg === '--until') {
      flags.until = requireValue(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--ids') {
      flags.ids = requireValue(arg, argv[i + 1])
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === '--file') {
      flags.file = path.resolve(requireValue(arg, argv[i + 1]));
      i += 1;
    } else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--quiet') flags.quiet = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown flag for loop review: ${arg}`);
    else throw new Error(`Unexpected argument for loop review: ${arg}`);
    i += 1;
  }

  return flags;
}

function parseGoalArgs(argv: string[], env: Record<string, string | undefined>): GoalFlags {
  const flags: GoalFlags = {
    text: null,
    name: null,
    file: null,
    roundLimit: null,
    budgetUsd: null,
    onSessionLimit: null,
    onWeeklyLimit: null,
    supersedeLimit: null,
    dryRun: false,
    quiet: defaultQuiet(env),
    help: false,
    config: {},
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    const consumed = consumeConfigFlag(argv, i, flags.config);
    if (consumed !== null) {
      i = consumed;
      continue;
    }
    if (arg === '--name') {
      flags.name = requireValue(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--file') {
      flags.file = path.resolve(requireValue(arg, argv[i + 1]));
      i += 1;
    } else if (arg === '--round-limit') {
      flags.roundLimit = parsePositiveNumber(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--budget') {
      flags.budgetUsd = parsePositiveNumber(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--on-session-limit') {
      flags.onSessionLimit = parseLimitPolicy(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--on-weekly-limit') {
      flags.onWeeklyLimit = parseLimitPolicy(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--supersede-limit') {
      flags.supersedeLimit = parsePositiveNumber(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--quiet') flags.quiet = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown flag for loop goal: ${arg}`);
    else if (flags.text === null) flags.text = arg;
    else throw new Error(`Unexpected extra argument for loop goal: ${arg} (quote the goal text)`);
    i += 1;
  }

  return flags;
}

function parseInitArgs(argv: string[], env: Record<string, string | undefined>): InitFlags {
  const flags: InitFlags = {
    interactive: false,
    noDiscovery: false,
    quiet: defaultQuiet(env),
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '--interactive') flags.interactive = true;
    else if (arg === '--no-discovery') flags.noDiscovery = true;
    else if (arg === '--agent-cli') {
      flags.agentCli = parseAgentCli(argv[i + 1]);
      i += 1;
    } else if (arg === '--verify-cmd') {
      flags.verifyCmd = requireValue(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--issues-dir') {
      flags.issuesDir = requireValue(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--specs-dir' || arg === '--prds-dir') {
      flags.specsDir = requireValue(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--project') {
      flags.project = requireValue(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--project-verify-cmd') {
      flags.projectVerifyCmd = requireValue(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--project-spec' || arg === '--project-prd') {
      flags.projectSpec = requireValue(arg, argv[i + 1]);
      i += 1;
    } else if (arg === '--quiet') flags.quiet = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown flag for loop init: ${arg}`);
    else throw new Error(`Unexpected argument for loop init: ${arg}`);
    i += 1;
  }

  return flags;
}

function parseInstallArgs(argv: string[]): InstallFlags {
  const flags: InstallFlags = { targets: [...PLANNING_SKILL_TARGETS], interactive: false, force: false, dryRun: false, help: false };
  let bundle: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--targets') {
      const targets = requireValue(arg, argv[++i]).split(',').map((target) => target.trim());
      if (targets.some((target) => !(PLANNING_SKILL_TARGETS as readonly string[]).includes(target))) {
        throw new Error(`--targets must be a comma-separated list of: ${PLANNING_SKILL_TARGETS.join(', ')}`);
      }
      flags.targets = [...new Set(targets)] as PlanningSkillTarget[];
    } else if (arg === '--scope') {
      const scope = requireValue(arg, argv[++i]);
      if (scope !== 'project' && scope !== 'user') throw new Error('--scope must be project or user');
      flags.scope = scope;
    } else if (arg === '--interactive') flags.interactive = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown flag for loop install: ${arg}`);
    else if (bundle === null) bundle = arg;
    else throw new Error(`Unexpected extra argument for loop install: ${arg}`);
  }
  if ((!bundle && !flags.help) || (bundle && bundle !== 'planning-skills')) {
    throw new Error('Usage: loop install planning-skills [--targets claudecode,codexcli,cursor,copilot]');
  }
  return flags;
}

function parseFixNitsArgs(argv: string[], env: Record<string, string | undefined>): FixNitsFlags {
  const flags: FixNitsFlags = { dryRun: false, quiet: defaultQuiet(env), help: false, config: {} };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    const consumed = consumeConfigFlag(argv, i, flags.config);
    if (consumed !== null) {
      i = consumed;
      continue;
    }
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--quiet') flags.quiet = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown flag for loop fix-nits: ${arg}`);
    else throw new Error(`Unexpected argument for loop fix-nits: ${arg}`);
    i += 1;
  }

  return flags;
}

function parsePolishArgs(argv: string[], env: Record<string, string | undefined>): PolishFlags {
  const flags: PolishFlags = { project: null, dryRun: false, quiet: defaultQuiet(env), help: false, config: {} };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    const consumed = consumeConfigFlag(argv, i, flags.config);
    if (consumed !== null) {
      i = consumed;
      continue;
    }
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--quiet') flags.quiet = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown flag for loop polish: ${arg}`);
    else if (flags.project === null) flags.project = arg;
    else throw new Error(`Unexpected extra argument for loop polish: ${arg}`);
    i += 1;
  }

  return flags;
}

function parseArchiveArgs(argv: string[]): ArchiveFlags {
  const flags: ArchiveFlags = { project: null, dryRun: false, help: false, config: {} };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    const consumed = consumeConfigFlag(argv, i, flags.config);
    if (consumed !== null) {
      i = consumed;
      continue;
    }
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown flag for loop archive: ${arg}`);
    else if (flags.project === null) flags.project = arg;
    else throw new Error(`Unexpected extra argument for loop archive: ${arg}`);
    i += 1;
  }

  return flags;
}

export function parseCliArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): ParsedCli {
  const [first, ...rest] = argv;

  if (first === undefined || first === 'help') return { command: 'help' };
  if (first === '--version' || first === '-v') return { command: 'version' };
  if (first === '--help' || first === '-h') return { command: 'help' };

  if (first === 'run') return { command: 'run', flags: parseRunArgs(rest, env) };
  if (first === 'review') return { command: 'review', flags: parseReviewArgs(rest, env) };
  if (first === 'fix-nits') return { command: 'fix-nits', flags: parseFixNitsArgs(rest, env) };
  if (first === 'polish') return { command: 'polish', flags: parsePolishArgs(rest, env) };
  if (first === 'archive') return { command: 'archive', flags: parseArchiveArgs(rest) };
  if (first === 'goal') return { command: 'goal', flags: parseGoalArgs(rest, env) };
  if (first === 'goals') {
    return { command: 'goals', help: rest.includes('--help') || rest.includes('-h') };
  }
  if (first === 'init') return { command: 'init', flags: parseInitArgs(rest, env) };
  if (first === 'install') return { command: 'install', flags: parseInstallArgs(rest) };

  if (first === 'list-runs') {
    return { command: 'list-runs', help: rest.includes('--help') || rest.includes('-h') };
  }

  if (first === 'completion') {
    const help = rest.includes('--help') || rest.includes('-h');
    const shell = rest.find((arg) => !arg.startsWith('-')) ?? null;
    if (shell !== null && !(COMPLETION_SHELLS as readonly string[]).includes(shell)) {
      throw new Error(`Unsupported completion shell "${shell}" — supported: ${COMPLETION_SHELLS.join(', ')}`);
    }
    return { command: 'completion', shell: shell as CompletionShell | null, help };
  }

  if (first === '__complete') {
    // Words after a `--` separator are the raw command line being completed.
    const sep = rest.indexOf('--');
    return { command: '__complete', words: sep === -1 ? rest : rest.slice(sep + 1) };
  }

  return { command: 'unknown', name: first };
}
