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
  install planning-skills  Install planning skills for local coding agents using rulesync
  run [project]      Pick and complete unblocked issues (optionally limited to one project)
  review             Review selected issues (optionally fixing blocking findings)
  fix-nits           Work through the accumulated nits backlog (.loop/nits.md) in one session
  polish             Wrap up a project: fix-nits batch, then distill its notes into CONTEXT.md
  archive            Retire a wrapped-up project into <archiveDir>/<date>-<project>/
  goal [text|slug]   Loop plan → drain → evaluate rounds toward a stated outcome (no spec needed)
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
  project                     Only work on issues in this project folder (e.g. SPEC-006)

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

export function polishHelp(): string {
  return `Usage: loop polish <project> [options]

The wrap-up pass for a project, two sessions under one invocation:
  1. fix-nits — the atomic batch over .loop/nits.md (skipped when empty)
  2. distill  — promote the project's shared notes (.loop/notes/<project>.md)
                and archived handoffs into the repo's tracked CONTEXT.md files,
                shrink the notes back down, verify, commit

A failed nits phase stops the polish before distilling.

Options:
  --dry-run                   Print the distill prompt without calling any agent
${SHARED_FLAG_HELP}

${SHARED_ENV_HELP}`;
}

export function archiveHelp(): string {
  return `Usage: loop archive <project> [options]

The sequel to \`loop polish\`: move a wrapped-up project's material under one
dated folder at <archiveDir>/<date>-<project>/ — its issues, run artifacts,
archived handoffs, project notes, and its projects.<name> config entry
(written as loop.project.json, itself a valid partial config).

A nested spec project is kept together under planning/ in the archive.
Nothing is deleted. Reverting is moving the folder back. The only removals are
directories the move left empty.

Refuses when: archiveDir is unset, any issue is still runnable, the dated
folder already exists, or another loop invocation holds the lock.

Options:
  --dry-run                   Print the exact plan without moving anything
${SHARED_FLAG_HELP}

${SHARED_ENV_HELP}`;
}

export function initHelp(): string {
  return `Usage: loop init [options]

Guided setup for loop.config.json. Detects installed agent CLIs, optionally
runs a bounded read-only discovery session that learns the repo (candidate
verify command — validated by executing it — plus issue/spec directories),
then asks each question with the findings as suggested defaults. Filesystem
discovery also finds issue/spec roots and unregistered project slugs without
an agent session. Accept suggested paths or enter custom paths. New setups
default both scan roots to specs: specs/<YYYYMMDD>-<project>/spec.md and
specs/<YYYYMMDD>-<project>/issues/. The dated folder name is the project ID.

An existing config is extended, never clobbered: keys with values are kept;
only missing keys and new projects.<name> entries are written.

With no TTY, init uses the flag-driven form (no discovery, no questions) and
requires --verify-cmd when creating a fresh config; --interactive forces the
guided flow even when piped (answers can be piped in up front).

Options:
  --interactive               Guided flow even without a TTY
  --no-discovery              Skip the agent survey; keep filesystem suggestions
  --agent-cli CLI             cursor|claude-code|codex|copilot
  --verify-cmd CMD            Verify command to write
  --issues-dir PATH           Root containing project issue folders
  --specs-dir PATH            Specs directory to write
  --project NAME              Add a projects.NAME entry…
  --project-verify-cmd CMD    …with this per-project verify command
  --project-spec PATH         …and/or this spec path/prefix
  --quiet                     Hide the discovery session's live stream
  -h, --help                  Show this help`;
}

export function goalHelp(): string {
  return `Usage: loop goal ["<goal text>" | <slug>] [options]

Goal mode: no spec, no curated backlog. Loop cycles plan → drain → evaluate —
a fresh session plans the smallest next batch of issues, the regular pipeline
works them (each implement session declares its own verify command), and a
fresh session judges the goal against the observable repo state — until the
goal is reached or needs a human. An existing slug resumes where it stopped.

State lives at .loop/goals/<slug>/ (goal.md, issues/, verify declarations,
evaluations, rounds).

Options:
  --name SLUG                 Slug for a new goal (default: derived from the text)
  --file PATH                 Read the goal text from a file
  --round-limit N             Max plan→drain→evaluate rounds this invocation
  --budget DOLLARS            Stop once cumulative *reported* spend crosses this
  --on-session-limit POLICY   wait|stop when a session usage limit hits (default: goal.usageLimits, then usageLimits)
  --on-weekly-limit POLICY    wait|stop when a weekly usage limit hits (same fallback chain)
  --supersede-limit N         Max replacements per escalated-issue lineage (default: goal.supersedeLimit, 3)
  --dry-run                   Show what the next round would do without running anything
${SHARED_FLAG_HELP}

${SHARED_ENV_HELP}`;
}

export function goalsHelp(): string {
  return `Usage: loop goals

List every goal under .loop/goals/ with its status, round count, backlog size,
and headline. Resume one with \`loop goal <slug>\`.`;
}

export function reviewHelp(): string {
  return `Usage: loop review [--fix] [--until ID | --ids ID1,ID2 | --file PATH] [options]

Run a review session for the selected issues. Issue references accept a
qualified id (project/id, e.g. SPEC-006/issue-07) or a bare local id when it is
unambiguous repo-wide.

Options:
  --fix                       Fix blocking findings in a review↔implement loop
  --until ID                  Review all issues up to and including ID
  --ids ID1,ID2,...           Review explicit issue ids (comma-separated)
  --file PATH                 Review issue ids listed in a file (one per line)
  --dry-run                   Print review prompts without calling the agent
${SHARED_FLAG_HELP}

${SHARED_ENV_HELP}`;
}

export function listRunsHelp(): string {
  return `Usage: loop list-runs

Print every recorded run from .loop/runs.jsonl (newest last). Run artifacts
live under .loop/runs/<project>/<timestamp>-<issue-id>/.`;
}

export function completionHelp(): string {
  return `Usage: loop completion <bash|zsh>

Print an installable shell completion script. Install with:
  eval "$(loop completion zsh)"   # in ~/.zshrc
  eval "$(loop completion bash)"  # in ~/.bashrc`;
}

export function installHelp(): string {
  return `Usage: loop install planning-skills [options]

Generate the bundled pre-loop planning skills with rulesync and install them
into project or user agent skill directories. Loop includes rulesync;
no separate installation or global rulesync executable is needed.
Includes grilling, grill-with-docs, domain-modeling, wayfinder, to-spec, to-issues.

Options:
  --scope SCOPE    project or user. Without this flag, terminals ask where to
                   install; non-interactive commands default to project.
  --interactive    Ask where to install even when input is piped
  --targets LIST   Comma-separated rulesync targets (default: all four below)
                   claudecode (.claude/skills), codexcli (.agents/skills),
                   cursor (.cursor/skills), copilot (.github/skills)
  --dry-run        Generate in a temporary directory and preview destination paths
  --force          Overwrite differing files with these skill names
  -h, --help       Show help

Identical files are left alone. Differing files stop installation before any
destination writes unless --force is set. Symlink destinations are always refused.
User scope installs beneath your home directory: ~/.claude/skills,
~/.agents/skills, ~/.cursor/skills, and ~/.copilot/skills.
Generation uses an isolated config for both scopes.`;
}
