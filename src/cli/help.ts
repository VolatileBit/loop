/** Usage text for `loop` and each subcommand. */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function loopVersion(): string {
  const pkg = require('../../package.json') as { version?: string };
  return pkg.version ?? '0.0.0';
}

export function loopDescription(): string {
  const pkg = require('../../package.json') as { description?: string };
  return pkg.description ?? '';
}

const SHARED_FLAG_HELP = `  --model MODEL               Model for every stage (default: auto; per-stage via loop.config.json "stages")
  --effort LEVEL              Reasoning effort for every stage (Claude/Copilot --effort, Codex model_reasoning_effort; not supported on cursor)
  --agent-cli CLI             Agent CLI for every stage: cursor|claude-code|codex|copilot (default: cursor)
  --verify-cmd CMD            Shell command run after each agent turn
  --issues-dir PATH           Issue root (default: issues/)
  --agent-timeout-ms MS       Wall-clock cap per agent run (default: 7200000 = 2h)
  --agent-idle-timeout-ms MS  Kill if no agent output for this long (default: 1200000 = 20m)
  --heartbeat-interval-ms MS  Progress log interval while agent runs (default: 60000)
  --quiet                     Hide live agent stream (heartbeats only)
  --no-thinking               Hide agent thinking blocks from the live stream
  --no-worktree               Work directly in the repo instead of the rolling loop worktree
  --max-review-cycles N       Max review↔implement cycles before human escalation (default: 3)
  --max-verify-cycles N       Max verify↔implement fix cycles before verify-failed (default: 3)
  --max-parallel-runs N       Concurrent issues, each in its own worktree (default: 1)`;

const SHARED_ENV_HELP = `Environment:
  LOOP_MODEL                   Same as --model
  LOOP_VERIFY_CMD              Same as --verify-cmd
  LOOP_AGENT_TIMEOUT_MS        Same as --agent-timeout-ms
  LOOP_AGENT_IDLE_TIMEOUT_MS   Same as --agent-idle-timeout-ms
  LOOP_HEARTBEAT_INTERVAL_MS   Same as --heartbeat-interval-ms
  LOOP_QUIET=1                 Same as --quiet
  LOOP_SHOW_THINKING=0         Same as --no-thinking
  LOOP_MAX_REVIEW_CYCLES       Same as --max-review-cycles
  LOOP_MAX_VERIFY_CYCLES       Same as --max-verify-cycles
  LOOP_MAX_PARALLEL_RUNS       Same as --max-parallel-runs
  LOOP_NO_WORKTREE=1           Same as --no-worktree

Configuration: loop.config.json at the target repo root (see README.md).
Precedence: CLI flag > env var > loop.config.json > built-in default.`;

export function mainHelp(): string {
  return `loop ${loopVersion()} — ${loopDescription()}

Usage: loop <command> [options]

Commands:
  init               Guided setup: detect agent CLIs, discover the repo, write loop.config.json
  run [project]      Pick and complete unblocked issues (optionally limited to one project)
  review             Review selected issues (optionally fixing blocking findings)
  fix-nits           Work through the accumulated nits backlog (.loop/nits.md) in one session
  polish             Wrap up a project: fix-nits batch, then distill its notes into CONTEXT.md
  archive            Retire a wrapped-up project into <archiveDir>/<date>-<project>/
  goal [text|slug]   Loop plan → drain → evaluate rounds toward a stated outcome (no PRD needed)
  goals              List goals with their status, round, and issue counts
  list-runs          Print recorded runs from .loop/runs.jsonl
  completion SHELL   Print a bash or zsh completion script

Options:
  -h, --help         Show help (also available per subcommand)
  -v, --version      Print the loop version

Run \`loop <command> --help\` for that command's flags.`;
}

export function runHelp(): string {
  return `Usage: loop run [project] [options]

Pick the next unblocked issue, drive the implement → verify → review pipeline
against it, and repeat until no work remains or you stop it. A re-picked
failed issue resumes at its recorded lastStage checkpoint.

Arguments:
  project                     Only work on issues in this project folder (e.g. PRD-006)

Options:
  --once                      Run one issue iteration and exit
  --dry-run                   Print next issue and prompt without calling the agent
  --unblock                   First flip needs-human issues (in project) back to runnable failure roles
  --max-iterations N          Cap on issues completed in this invocation (default: unlimited)
  --budget DOLLARS            Stop claiming new issues once cumulative *reported* spend crosses this
                              (only claude-code reports cost; other CLIs' spend is invisible to the cap)
${SHARED_FLAG_HELP}

${SHARED_ENV_HELP}`;
}

export function fixNitsHelp(): string {
  return `Usage: loop fix-nits [options]

Work through every entry in the nits backlog (.loop/nits.md) in one agent
session: fix or dismiss each finding, verify, and commit. The batch is atomic —
any failure restores nits.md to its pre-session state.

Options:
  --dry-run                   Print the fix-nits prompt without calling the agent
${SHARED_FLAG_HELP}

${SHARED_ENV_HELP}`;
}
