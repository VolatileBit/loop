# loop

Autonomous issue-runner for markdown issue trackers. Loop drives a coding agent through **implement → verify → review** cycles against your repo's issues, in an isolated git worktree, with optional parallel runs and resumable stage checkpoints.

## Features

- Repo-agnostic — operates on `process.cwd()` with a `loop.config.json` at the repo root
- Drives a coding agent through implement, verify and review, then commits
- Verify gate is whatever command the repo already uses
- Markdown issues on disk, no tracker to integrate with
- Worktree isolation so a run never disturbs your checkout

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

