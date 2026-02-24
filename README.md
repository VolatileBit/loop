# loop

Autonomous issue-runner for markdown issue trackers. Loop drives a coding agent through **implement → verify → review** cycles against your repo's issues, in an isolated git worktree, with optional parallel runs and resumable stage checkpoints.

## Features

- **Repo-agnostic** — operates on `process.cwd()` with a `loop.config.json` at the repo root
- **Multi-agent** — Cursor, Claude Code, Codex, or GitHub Copilot CLI; mix providers/models per stage via config
- **Verify + review pipeline** — external verify command, `/review-work`-style review sessions, auto-commits
- **Convergence-aware review fixes** — review agents group findings by stable root-cause families; recurring families trigger invariant/matrix-oriented deep-fix prompts and specific escalation reports
- **Evidence-based verify skip** — when a session provably ran the exact verify command to success as its last tree-touching act, loop skips its duplicate re-run (see [How verify skipping works](#evidence-based-verify-skip))
- **Resumable checkpoints** — runnable issues with `lastStage` resume there instead of restarting from implement
- **Worktree isolation** — rolling worktree by default; optional parallel per-issue worktrees with post-merge verification
- **Unattended-run safety** — `--budget` spend cap, usage-limit wait-and-resume, in-place retries for provider infrastructure faults, a readiness probe before each claim, webhook notifications, per-repo invocation lock
- **Bundled skills** — set `tddSkill`/`reviewSkill` to `"builtin"` to embed loop's full TDD and two-axis review workflows into every prompt, identical across all agent CLIs, nothing to install
- **Nits backlog** — nits-only review findings accumulate in `.loop/nits.md`; `loop fix-nits` works through them in one atomic batch
- **Per-project runs and config** — `loop run PRD-006` limits the loop to one project folder; projects can override `verifyCmd`, PRD, model/effort, `env`, and the readiness probe via the `projects` config map, with a gitignored `loop.config.local.json` overlay for machine-specific settings
- **Declared verify commands** — a session may replace the gate for its own issue as implementation reveals what actually needs proving, fenced by the review, the post-merge check, and an announcement
- **Two-level stop** — one ESC finishes the current issue; a second parks it at the next stage boundary with its checkpoint intact
- **Project lifecycle** — `loop polish` wraps a project up (nits batch, then notes distilled into `CONTEXT.md`); `loop archive` retires it into a dated folder without deleting anything
- **Shell completion** — bash and zsh tab completion for subcommands, flags, projects, and issue IDs

## Requirements

- **Node.js** ≥ 20
- **git** — target directory must be a git repository
- **At least one agent CLI** on PATH for the stages you run (loop checks every distinct binary up front via `command -v`):
  - `cursor` (Cursor agent CLI)
  - `claude` (Claude Code)
  - `codex` (Codex CLI)
  - `copilot` (GitHub Copilot CLI)
- Loop checks every distinct agent binary on PATH at startup (`command -v`), then runs a **soft** `${binary} --version` probe (warn-only — does not block the run). When the CLI exposes a cheap auth-status command, loop also runs a **soft auth probe** (warn-only):
  - `claude auth status` (Claude Code)
  - `codex login status` (Codex)
  - `cursor agent status` (Cursor — loop invokes `cursor agent …`, not the standalone `agent` binary)
  - Copilot has **no** auth-status subcommand (OAuth device flow or `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` env tokens) — a logged-out copilot surfaces at the first session.
  Auth probe failures warn but never block startup; login problems still surface when the agent subprocess runs. Ensure each binary you use is installed and authenticated before long runs.
- **Markdown issues** under a configurable `issuesDir`, one project subdirectory per unit of work — a project can hold multiple features and fixes (e.g. one PRD, one refactor campaign)

## Install

### Global `loop` command (recommended)

```bash
cd /path/to/loop
npm install
npm link
# or: pnpm install && pnpm link --global

loop --help
```

From any git repo with a `loop.config.json`:

```bash
loop run --dry-run
loop run --once
```

To uninstall: `npm uninstall -g @polyweave/loop`

## Quick start

1. Add a `loop.config.json` at your repo root — either by hand (see [Configuration](#configuration)) or with the guided setup:

   ```bash
   loop init
   ```

   `loop init` detects installed agent CLIs, optionally runs a bounded **read-only discovery session** that learns the repo (candidate verify command — validated by actually executing it — plus issue/PRD directories), then asks each question with the findings as suggested defaults. An existing config is extended, never clobbered: keys with values are kept; only missing keys and new `projects.<name>` entries are written. Without a TTY it uses the flag-driven form (`loop init --verify-cmd "pnpm verify" --agent-cli claude-code …`, no discovery); `--interactive` forces the guided flow even when piped.

   Each question renders as a block — a blank line, the question in bold, the suggestion on its own line, and an explicit "Press Enter to accept, or type a replacement" — with only the short `>` marker handed to readline. That split matters: in terminal mode readline owns the input line and repaints it from its *own* prompt, so a question written straight to stdout is overwritten the moment anything triggers a redraw, which is guaranteed once a multi-minute discovery session has streamed output between questions. Yes/no questions use a distinct `[Y/n]` form so they cannot be confused with free-text ones — a bare `Verify command [pnpm verify]:` invites the answer "no", which would otherwise be written into the config as the gate. A hand-typed verify command is trialled before it is accepted: one that cannot *execute* re-asks the question, while one that runs and merely fails is kept with a warning (a red suite is a fact about the repo, not about the answer).

   On the way out, init ensures `.loop/` and `loop.config.local.json` are gitignored — announced, never silent, and skipped when git already covers them by any mechanism. This is not cosmetic: an unignored `.loop/` puts run artifacts in the diff, where a later review-fix session tidying stray files can delete the live run directory mid-run.

2. Create issues under `issues/<project>/` (see [Issue tracker conventions](#issue-tracker-conventions)).
3. Dry-run to confirm scheduling:

   ```bash
   loop run --dry-run
   ```

4. Run one issue:

   ```bash
   loop run --once
   ```

5. Loop until blocked or done:

   ```bash
   loop run
   ```

If `verifyCmd` is not set in config, flags, or env, `loop run` fails fast with instructions.

