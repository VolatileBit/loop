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

## Configuration

Config file: **`loop.config.json`** at the target repo root (tracked in git). Runtime state lives in gitignored `.loop/`.

**Machine-local overlay.** `loop.config.local.json`, if present, is read *over* the tracked file — commit the shared settings, keep the machine-specific ones out of git. A project entry often names an in-progress branch, a local PRD path and a command only your machine can run; that belongs to whoever runs loop, not to the repo. Objects that describe a *set* of things (`projects`, `stages`, `triageLabels`, `env`, `usageLimits`, `goal`) merge one level deep, so a local `projects` entry adds to the tracked map instead of replacing it; every other value, arrays included, is replaced outright — a local `fallbackAgents` chain is a whole statement, not an addition. Validation runs on the merged result. Add it to `.gitignore` yourself; loop does not write there.

`loop.config.example.json` at this repo's root is a tracked reference showing every option, kept honest by a drift test — an unread example file otherwise rots the moment a key is renamed.

**Precedence:** CLI flag > env var (where one exists) > `loop.config.json` > built-in default.

### Top-level fields

| Field | Default when unset | Description |
| ----- | ------------------ | ----------- |
| `agentCli` | `"cursor"` | Global default agent CLI (`cursor`, `claude-code`, `codex`, `copilot`) |
| `model` | `"auto"` | Global default model passed to the agent CLI |
| `effort` | unset (`null`) | Global default reasoning effort (Claude/Copilot `--effort`, Codex `model_reasoning_effort`); not supported on cursor |
| `fallbackAgents` | `[]` | Ordered agent CLI fallbacks tried when the active CLI hits a usage limit (see below) |
| `verifyCmd` | none | Shell command run after each agent turn; **required** somewhere before `run`/`review` |
| `issuesDir` | `"issues"` | Issue root relative to repo root |
| `maxVerifyCycles` | `3` | Max verify↔fix cycles before `verify-failed` |
| `maxReviewCycles` | `3` | Max review↔fix cycles before human escalation (recurring finding families automatically deepen later fix prompts) |
| `agentTimeoutMs` | `7200000` (2h) | Wall-clock cap per agent session |
| `agentIdleTimeoutMs` | `1200000` (20m) | Kill if no agent output for this long |
| `heartbeatIntervalMs` | `60000` | Progress log interval while an agent or external verification command runs |
| `showThinking` | `true` | Show thinking blocks in live stream (`--no-thinking` / `LOOP_SHOW_THINKING=0` to hide) |
| `worktreeEnabled` | `true` | Use rolling loop worktree (`--no-worktree` / `LOOP_NO_WORKTREE=1` to disable) |
| `keepAwake` | `true` | Hold a macOS sleep inhibitor for the whole invocation (`--no-caffeinate` to disable) |
| `reviewSkill` | unset | Skill directive in review prompts (e.g. `"/review-work"`), or `"builtin"` to embed loop's bundled two-axis review workflow |
| `tddSkill` | unset | Skill directive in implement prompts (e.g. `"/tdd"`), or `"builtin"` to embed loop's bundled TDD workflow |
| `commitExcludePaths` | `[]` | Paths excluded from loop commits (staged then unstaged before committing); `.loop/` is always excluded on top of these |
| `installCmd` | unset | Run when lockfiles change during worktree sync (e.g. `"pnpm install"`) |
| `dependencyFiles` | `package.json`, lockfiles | Files whose changes trigger `installCmd` |
| `prdsDir` | unset | PRD/feature doc directory for prompt context (e.g. `"docs/prd"`) |
| `triageLabels` | loop defaults (see below) | Map semantic roles to label strings in issue frontmatter |
| `maxParallelRuns` | `1` | Concurrent issues, each in its own worktree |
| `projects` | `{}` | Per-project `verifyCmd`/`prd`/`env`/`preflight`/`usageLimits` overrides (see [Per-project overrides](#per-project-projects-overrides)) |
| `webhooks` | `[]` | Outbound notifications (see [Webhook notifications](#webhook-notifications)) |
| `env` | `{}` | Environment merged over the inherited env for every session and verify run (see [Environment and readiness](#environment-and-readiness)) |
| `preflight` | unset | `{ cmd, message }` readiness probe run before each claim (see [Environment and readiness](#environment-and-readiness)) |
| `allowDeclaredVerify` | `true` | Let a session replace `verifyCmd` for the issue it is working on (see [Declared verify commands](#declared-verify-commands)) |
| `archiveDir` | **none — required by `archive`** | Where `loop archive` moves a wrapped-up project (see [`loop archive`](#loop-archive-project)) |
| `usageLimits` | `{"session": "wait", "weekly": "stop"}` | Per-window usage-limit policy (see [Usage-limit handling](#usage-limit-handling)) |
| `agentRetries` | `{"attempts": 2, "initialDelayMs": 15000, "maxDelayMs": 180000}` | In-place retries for sessions killed by provider infrastructure (see [Infrastructure-fault retries](#infrastructure-fault-retries)) |
| `goal` | `{"maxIssuesPerRound": 5, "roundLimit": null}` | Goal-mode settings, incl. optional `usageLimits` (see [Goal mode](#goal-mode-loop-goal)) |

### Per-stage `stages` overrides

Override `agentCli`, `model`, and/or `effort` independently for each session kind:

```json
{
  "agentCli": "cursor",
  "model": "auto",
  "effort": "medium",
  "stages": {
    "implement": { "agentCli": "claude-code", "model": "sonnet-5", "effort": "high" },
    "verifyFix": { "agentCli": "cursor" },
    "review": { "agentCli": "codex", "model": "gpt-5.5", "effort": "xhigh" },
    "reviewFix": { "agentCli": "claude-code", "model": "sonnet-5", "effort": "high" }
  }
}
```

**Effort levels** map to each CLI's native flag (loop passes them through verbatim):

| Provider | CLI flag | Allowed values |
| -------- | -------- | -------------- |
| `claude-code` | `claude -p --effort <level>` | `low`, `medium`, `high`, `xhigh`, `max` |
| `codex` | `codex exec -c model_reasoning_effort="<level>"` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `copilot` | `copilot -p --effort <level>` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `cursor` | — | **not supported** — loop fails at startup if effort is set for a stage that resolves to cursor |

Omitted `effort` lets the agent CLI use its own default. Not every model supports every level — mismatches surface as CLI warnings or runtime errors from the provider.

Stage names: `implement`, `verifyFix`, `review`, `reviewFix`, plus goal mode's `plan` and `evaluate`. Omitted fields fall back to top-level defaults (not other stages). CLI `--agent-cli` / `--model` / `--effort` override **all** stages for one invocation.

### Usage-limit fallback agents

`fallbackAgents` is a global, ordered failover chain for every agent stage:

```json
{
  "agentCli": "codex",
  "model": "gpt-5.6-sol",
  "effort": "xhigh",
  "fallbackAgents": [
    { "agentCli": "claude", "model": "opus-5", "effort": "high" },
    { "agentCli": "copilot" }
  ]
}
```

The active stage's resolved agent runs first. If that CLI reports a provider usage limit, loop immediately tries each distinct fallback in order. Once failover has begun, a broken fallback does not prevent loop from trying later entries. Loop waits or stops according to `usageLimits` only when every attempted CLI reported a usage limit; if any fallback failed for another reason and none succeeded, the stage fails without waiting. An authentication failure, crash, timeout, or ordinary agent error from the primary CLI does not activate failover.

`model` and `effort` are optional per fallback. When omitted, that fallback CLI chooses its own defaults; loop does not inherit values that may only be valid for the primary provider. `"claude"` is accepted here as an alias for the canonical `"claude-code"` value. CLI `--agent-cli` / `--model` / `--effort` flags change the primary candidate only; the configured fallback entries remain intact.

Provider limits are remembered for the lifetime of the `loop` process and shared across stages, issues, and parallel workers. Each new agent session starts with the highest-priority CLI not currently known to be limited, so later stages go directly to Claude or Copilot instead of repeatedly probing a limited Codex account. If another fallback reaches its limit, later sessions continue farther down the chain. A provider returns to its original priority after its reported reset time (plus the normal one-minute buffer); when the reset time is missing or already stale, loop probes it again after 15 minutes. Starting a new `loop` process starts with no prior quota observations and probes the configured primary normally.

Every attempted session remains visible in the aggregate stream log, even when a later fallback completes the stage. When a CLI reports token or cost telemetry, loop retains it for that attempt in the run accounting.

Before any work starts, `loop run` / `loop review` call `checkAgentBinaries`: every distinct primary and fallback `binaryName` resolved across the stages the command will run must be on PATH, or loop fails fast naming the missing binary and which stage(s) need it. Follow-up soft probes (never block startup):

1. `warnIfAgentBinariesNotRunnable` — `${binary} --version` (5s timeout)
2. `warnIfAgentBinariesNotAuthenticated` — CLI-specific auth status when documented in `--help`:
   - `claude auth status` → JSON `loggedIn`
   - `codex login status` → exit code
   - `cursor agent status` → exit code (loop uses the `cursor` binary, not standalone `agent`)

There is no separate auth probe for a bare `agent` binary because loop's Cursor provider always spawns `cursor agent …`.

**Live-run caveats (mixed stages / parallel):**

- **Codex models** — use `"auto"` or a model your Codex login supports. Arbitrary model slugs (e.g. `gpt-5-codex-mini`) can fail at runtime with `turn.failed` even when `codex --version` passes; loop marks the review stage as failed but the console may still show a generic “verdict block missing” summary parsed from the error JSON.
- **Parallel runs** — issues that touch the same files (e.g. two README edits) can complete in their worktrees but fail on merge-back; loop escalates to `needs-human` and keeps the per-issue worktree for manual resolution. Re-run with `--unblock` after resolving.
- **Leftover worktrees** — loop warns and can re-attach to an existing per-issue worktree on the next pick of that issue.

### Per-project (`projects`) overrides

A **project** is one folder under `issuesDir` — a unit of work that can hold multiple features and fixes (one PRD, one refactor campaign, a `hotfixes` bucket). The `projects` map overrides cross-cutting settings for the issues of one project, keyed by the folder name:

```json
{
  "verifyCmd": "pnpm verify",
  "projects": {
    "PRD-006": { "verifyCmd": "pnpm --filter @org/web run verify", "prd": "docs/prd/PRD-006-web.md" },
    "hotfixes": { "verifyCmd": "pnpm test" }
  }
}
```

- `verifyCmd` — gates that project's issues everywhere the global one would (pipeline verifies, batch `--fix`, post-merge verification). The per-project value wins over the global — **including a `--verify-cmd` flag**, which overrides the global default only (per-project entries exist precisely because the global command is wrong for them). The global `verifyCmd` remains required as the fallback; `loop fix-nits` always uses the global (its batch spans projects).
- `prd` — the PRD doc surfaced in that project's prompts: a repo-relative path, or a filename prefix within `prdsDir`. Issue-level `prd:` frontmatter still wins.
- `model` / `effort` — model and reasoning effort for this project's sessions. They replace the cross-cutting defaults but **lose to a per-stage `stages.<stage>` entry**: a per-stage value states something about a *kind of work* that holds across projects, so a project default must not silently undo it. Effort is validated against the CLI each stage resolves to at load time, naming the project, so an invalid pairing fails before any session spawns. There is deliberately **no** per-project `agentCli` — the startup check that every needed CLI is present runs before a project is known, so a per-project agent could slip past it and fail mid-backlog.
- `usageLimits` — partial `{ "session"?, "weekly"? }` policy map for this project's issues (see [Usage-limit handling](#usage-limit-handling)); unset scopes fall back to the global map.
- `env` — environment for this project's sessions and verify runs, merged over the global `env` key by key (see [Environment and readiness](#environment-and-readiness)).
- `preflight` — readiness probe for this project; **replaces** the global probe rather than adding to it.
- `allowDeclaredVerify` — whether this project's sessions may replace the verify command for one issue (see [Declared verify commands](#declared-verify-commands)).

### PRD context (`prdsDir`)

When `prdsDir` is set, implement/review prompts may include a line pointing at the parent feature doc. Resolution order (most specific wins):

1. `prd:` issue frontmatter (repo-relative path, or filename prefix in `prdsDir`)
2. The project's `projects.<name>.prd` config entry (same forms)
3. Match `issue.project` against filenames in `prdsDir` (case-insensitive prefix, e.g. project `PRD-006` → `docs/prd/PRD-006-*.md`)

### Triage vocabulary

Loop's state machine uses fixed **roles** internally. The strings written to issue `triage:` are configurable via `triageLabels`.

| Role | Loop default label | Notes |
| ---- | ------------------- | ----- |
| `needsTriage` | `needs-triage` | |
| `needsInfo` | `needs-info` | |
| `readyForAgent` | `ready` | override e.g. `ready-for-agent` |
| `readyForHuman` | `needs-human` | loop tried and got stuck; override e.g. `ready-for-human` |
| `delegatedToHuman` | `delegated` | a person has taken this work on — see below |
| `wontfix` | `wontfix` | |
| `inProgress` | `in-progress` | |
| `done` | `done` | override e.g. `agent-done` |
| `verifyFailed` | `verify-failed` | |
| `agentFailed` | `agent-failed` | |
| `agentInterrupted` | `agent-interrupted` | |


**Settled vs waiting.** `delegatedToHuman` is deliberately distinct from `readyForHuman`: both are non-runnable, but only one means loop is still owed something. Loop treats `done`, `wontfix` and `delegated` as **settled** — it is not waiting on anyone — so a backlog whose remainder a person has taken on reports `all-complete` rather than sending you to investigate an obstruction that doesn't exist. `needs-human`, `needs-info` and `needs-triage` are *not* settled. Delegated issues are announced by id at the end of a run and counted separately in the `run-completed` webhook, so "backlog complete" can never quietly stand in for "complete, except your part".

**Unknown labels are reported, not repaired.** A `triage:` value in no configured vocabulary makes an issue silently unclaimable — a typo removes it from the backlog with nothing said. Loop lists those issues at startup along with the valid labels, but never guesses which role was meant.

### Parallel runs (`maxParallelRuns`)

When `maxParallelRuns` > 1, loop claims up to N runnable issues concurrently. Each runs in a throwaway worktree branched from the rolling worktree, then merges back (including partial progress on failure). Console output switches to a compact multi-worker status view; full logs remain in `.loop/runs/`.

- **Merge-backs are verified.** When a worker merges and the rolling branch advanced past that worker's baseline (a sibling merged first), `verifyCmd` is re-run against the merged rolling state — textually clean but semantically broken combinations are caught here: the merge is rewound (rolling stays green) and the issue escalates to `needs-human` with its worktree preserved and instructions to adapt to the sibling's change. When nothing merged in between, the per-worktree verify already covered the exact same tree, so no extra run happens. This post-merge verify never consults in-session evidence — no single session saw the merged tree.
- **Escalations continue, hard failures drain.** A per-issue escalation (`needs-human`, `verify-failed`, merge or semantic conflict) parks that issue and the pool keeps claiming — one stuck issue doesn't strand an unattended run's remaining budget. A hard failure (agent crash, timeout, incomplete issue) usually points at something environmental, so the pool stops claiming, in-flight issues run to completion, and the run exits with the failures listed.

### Evidence-based verify skip

Loop's runner-owned verify normally re-runs `verifyCmd` after every implement/fix session — even when the session just ran the identical command itself. Loop makes the two runs mutually exclusive: **when the session's own stream proves the gate, the runner doesn't repeat it.**

What qualifies as proof (all harness-recorded, never agent prose):

- The session ran the **exact** verify command (or every `&&` segment of it, separately) via its shell tool, and the harness recorded success.
- **Nothing that could change the tree ran afterwards.** Git bookkeeping (`status`, `diff`, `log`, `show`, `rev-parse`, `branch`, `worktree list`, and crucially `add`/`commit` — the normal post-verify workflow) doesn't retract evidence; neither do read-only tools or file writes to absolute paths outside the worktree (loop's own bookkeeping lives there). Any other shell command, in-tree edit, or unknown/MCP tool retracts it.
- **Pipes never qualify.** `cmd 2>&1 | tail -20` masks the exit code, so piped/altered invocations are invalid evidence and get re-run. Prompts tell sessions the deal: run the command bare, as the last shell command before `git add`/`git commit`.
- A later failed run of the same command retracts the earlier pass.

On a skip, the verify log artifact records `SKIPPED` with the reason, and the console prints `verify satisfied in-session — skipping duplicate run`. Skipping applies to the initial post-implement verify, per-cycle re-verifies in fix loops, and batch `--fix` passes — each only from the session that just ran. The resume-time safety verify and the post-merge verify always run for real. Known caveat: a pre-commit hook that *mutates* files can stale evidence undetected; hooks whose fixers mirror the verify are safe in practice (a passing verify leaves them nothing to fix).

### Spend cap (`--budget`)

`loop run --budget 50` stops claiming new issues once cumulative **reported** spend crosses $50. Checked before each claim, not pre-emptively — an in-flight issue always finishes. Only Claude Code reports dollar cost in its stream; codex, cursor, and copilot report none, so their spend is invisible to the cap (loop warns at startup when capped stages resolve to cost-blind CLIs). Reported cost also appears as a `cost` column in the per-run usage table when present.

The usage table also carries an `elapsed` column per stage, plus a total: the wall time of each session, measured around the whole child lifetime, so a session killed by a wall or idle timeout still reports how long it burned first. An issue's stages run sequentially, so their sum is that issue's real elapsed time; a whole invocation's rollup spans parallel workers, where the sum is total *session* time rather than wall-clock. Elapsed times are persisted per stage in `summary.json` and `.loop/runs.jsonl`.

**Peak context is a high-water mark, not a total.** A session's terminal usage event is *cumulative*, so summing its input and cache reads reaches millions of tokens over a long run — meaningless next to a model window of a few hundred thousand. Loop instead takes the largest **single request** from the stream (claude-code's per-message `usage`, codex's per-turn `turn.completed`), reported as the `peak-ctx` column and a `Peak context: 230K tokens` footer. Across stages it is a **maximum**, never a sum — stages run one after another, so their contexts never coexist — and a mid-session compaction cannot lower it, since the peak already reached stands. Cursor and copilot report no per-request usage; for them the column reads `ctx~` and the footer says `Peak context (est.)`, so a real measurement and a fallback estimate can never be mistaken for each other.

### Usage-limit handling

When a session and all configured `fallbackAgents` hit provider usage limits, the `usageLimits` config decides what happens per limit window — `session` (5-hour-style) and `weekly`, each `"wait"` or `"stop"` (defaults: session `wait`, weekly `stop`). Loop uses the provider expected to recover soonest when choosing the wait window:

- **wait** — the pool drains in-flight issues, sleeps until the limit resets, then resumes claiming; the interrupted issue keeps its runnable role and `lastStage` checkpoint, so it's re-picked and resumes where it stopped. With no fallback chain, serial runs (and serial goal drains) **resume the dead provider session** with a continuation prompt — every CLI supports headless resume (`claude --resume`, `codex exec resume`, `cursor agent --resume`, `copilot --resume`), and the session id is captured from the CLI's own stream — so in-context work from before the limit isn't re-derived. After a whole fallback chain is exhausted, retry starts a fresh chain from the checkpoint and handoff notes because session identifiers are not portable between providers. A retry also starts fresh when no session id was captured or in parallel mode, where the re-claim may land in a different worktree (Claude scopes sessions per directory). On macOS the wait holds a `caffeinate -i` inhibitor so the machine stays awake until the reset (tied to the loop process — a crash releases it). The reset time is parsed from the CLI's own message when present (epoch fields, ISO timestamps, "try again in 2 hours", "resets 3am"); otherwise loop re-probes every 15 minutes. ESC still cancels a wait; an implausible (>8-day) reported reset stops instead of sleeping. Interrupted attempts don't count against `--once`/`--max-iterations`.
- **stop** — the run stops with the `usage-limit` outcome (exit code 2) and sends the `usage-limit` webhook event (scope, policy, best-effort reset time) so you hear about it while away.

**Recognising a limit is deliberately loose.** Vendors rename these windows without notice — claude-code has said "usage limit", "5-hour limit" and now "session limit" — so the detector matches "hit your … limit" whatever word lands in the middle, and works out *which* window it was separately. Missing a phrasing does not merely lose a message: loop would treat the dead session as a finished one, and a review that never ran would escalate the issue on a verdict nobody gave. For the same reason a review session that dies before answering now prints `NO REVIEW VERDICT` instead of the parser's safe default — the default is right for the pipeline, which must never land on silence, but printing it reads as the reviewer's judgement.

The policy is layered — the most specific setting wins per limit window:

- **Global**: the top-level `usageLimits` map.
- **Per project**: `projects.<name>.usageLimits` (partial — unset scopes fall back to global). The policy of the *issue that hit the limit* decides.
- **Goal mode**: `goal.usageLimits` overrides global for goal runs, and `loop goal --on-session-limit wait|stop` / `--on-weekly-limit wait|stop` override both for one invocation. Goal-mode `plan`/`evaluate` sessions honor the same policy: under `wait` they sleep and re-run the session (their prompts rebuild from files, so nothing is lost).

### Environment and readiness

The environment a verify command depends on used to be a documented precondition that nothing enforced, and there was nowhere to put environment setup — so it ended up inlined into the command string and re-run several times per issue.

```json
{
  "env": { "NX_DAEMON": "false" },
  "preflight": { "cmd": "pg_isready -q", "message": "start the dev database: `docker compose up -d db`" },
  "projects": {
    "web": { "env": { "DATABASE_URL": "postgres://localhost/web_fixtures" } }
  }
}
```

- **`env`** is merged over the inherited environment for every agent session *and* every verify run, so a command an agent proves by hand behaves identically when loop re-runs it (that equivalence is what makes the [evidence-based verify skip](#evidence-based-verify-skip) honest). Per-project `env` merges over the global one key by key, so a project adds to the cross-cutting settings rather than replacing them. It is also the right home for toolchain hygiene: loop gives every issue its own worktree, so daemon-spawning tools otherwise leak one background process per issue.
- **`preflight`** is a readiness probe run before each claim — cheap by design. A zero exit means ready; anything else stops the run with the `preflight-failed` reason and prints your `message`. In parallel runs the pool stops claiming and in-flight workers finish first. That reason **outranks** pipeline failures in the stop report, since issues failing after an outage are its symptoms, not its cause. Unlike `env`, a project's probe *replaces* the global one — two probes for one claim would only be a slower way to say the same thing. Unset (the default) disables the check.

Loop deliberately never *starts* what the probe checks. Bringing an environment up is a side effect on your own machine, and a gate that quietly applies migrations to a developer's database is worse than one that refuses to run.

### Declared verify commands

A project's `verifyCmd` is decided at setup time, but what actually needs proving often is not knowable then — a feature grows a service, a package, a migration, and the gate that was right on day one quietly stops covering the code being written. **A gate that misses an edited package doesn't fail loudly; it passes a real break silently.** With `allowDeclaredVerify`, a session may replace the command for the one issue it is working on, by writing it to `.loop/verify/<project>/<issue-id>.cmd`.

```json
{
  "verifyCmd": "npm run typecheck && npm test",
  "projects": { "docs": { "allowDeclaredVerify": false } }
}
```

This is **on by default**, and turned off per repo or per project for gates that must not move. It does hand a session authority over a human-approved gate, so it is fenced on four sides — the point of the fences is that being wrong produces a blocked review, never a silent pass:

1. **The implement prompt frames replacement as the exception**, names the configured command, and states that a replacement must be at least as strong over what the issue changed; narrowing it to dodge a failure is a blocking review finding.
2. **The review sees both commands side by side** and is told to block when the declared one is merely easier to pass — a subset of tests, a skipped typecheck, narrower coverage of the diff.
3. **Post-merge verification always runs the configured command**, so a narrowed gate cannot shrink what the merged tree is held to.
4. **Every replacement is printed**, once, as a badge with the configured and declared commands one above the other and the declaration file named. Both appear in full and aligned because the question is what *changed*: a replacement that quietly drops a package differs by a few words in the middle of a long command, and is invisible unless the two can be read against each other. Nothing is applied silently.

```
[19|verify] VERIFY COMMAND REPLACED
                                    configured pnpm nx run-many -t type:check test --projects=api,jobs && pnpm biome check services/api
                                    declared   pnpm nx run-many -t type:check test --projects=api,jobs,common,web && pnpm biome check services/api packages/common
                                    source     .loop/verify/PRD-011/issue-19.cmd
                                    post-merge verification runs the configured command.
```

The declaration is re-read before every run rather than cached — that is what keeps the [evidence-based skip](#evidence-based-verify-skip) honest: a session that proved the old command and then replaced it fails the evidence test and gets a real run. It also lets a later fix session correct a wrong choice. Declarations live under the main repo's `.loop/`, never inside a worktree, so writing one cannot retract the session's own in-session proof.

Goal mode already works this way and always has — there is no configured command to start from, so the implement session must declare one or the issue escalates as unverifiable.

### Infrastructure-fault retries

A session can die to the provider rather than to the work — a dropped connection mid-response, an overloaded backend, a 5xx. Nothing about the repo caused it and nothing about the repo will fix it, so loop retries **the same CLI in place** instead of failing the stage or spending a fallback slot:

```json
{
  "agentRetries": { "attempts": 2, "initialDelayMs": 15000, "maxDelayMs": 180000 }
}
```

- **What counts.** Classification runs over the same conservative probe as usage limits (stderr plus the failed result text, never a successful session's output) and only after a usage limit is ruled out — a quota hit is also a provider fault, but its remedy is the wait policy above, not an immediate retry. The shared signature table lives in `src/agent/providers/infra-error.ts`; each CLI extends it with its own phrasing via `isInfraError`, so a provider can widen the set but never loosen it. An agent's own prose about a failing test, a bare `error`, and a bare status number deliberately do not match.
- **What doesn't.** Loop's wall/idle timeouts are excluded — an agent that hung will hang again — as are ordinary failures like a bad auth token.
- **The work is kept.** When the dead session reported an id, the retry *resumes* it (same mechanism as the post-usage-limit resume) with a continuation prompt naming the provider fault as the cause — a session cut off twenty minutes in should not have to re-derive twenty minutes of exploration. Loop restarts fresh only when no id was captured or the CLI cannot resume.
- **Backoff** doubles per attempt from `initialDelayMs`, caps at `maxDelayMs`, and carries ±25% jitter: parallel workers fail together on one outage, and without jitter they would all return at the same instant and hit the recovering provider as a single spike. A force-stop cuts a backoff short rather than sitting it out.
- **Accounting.** Usage from the lost sessions still accumulates, or `--budget` would undercount a retried stage. Each attempt keeps its own stream log (`agent.stream.attempt-N-<cli>.log`) with the combined view at the usual path, and a stage that ran exactly one session is unchanged. When retries are exhausted the stop reason names the fault (`… failed after 3 attempt(s) — provider fault (connection-dropped); retries exhausted`) so an outage doesn't read like a code problem, and the run record carries `infraRetries`/`infraSignature`.

Set `"attempts": 0` to disable retrying entirely.

### Webhook notifications

Loop can POST to webhooks on the handful of signals worth walking away from a run for — deliberately no progress or heartbeat events:

| Event | When |
| ----- | ---- |
| `issue-completed` | An issue passed verify + review (serial: before the next claim; parallel: after its merge-back). |
| `issue-escalated` | An issue needs attention (`needs-human`, `verify-failed`, merge/semantic conflict) — the message includes the `loop run --unblock` command to run. |
| `run-completed` | The invocation ended: `all-complete`, or the stop reason (`blocked`, a failure kind, `budget-reached`, `stopped-by-user`, …), plus issues processed/escalated and usage. |
| `fix-nits-completed` | A `loop fix-nits` batch finished, with its outcome and fixed/dismissed counts. |
| `polish-completed` | A `loop polish` run finished (or stopped in one of its phases), with the project. |
| `goal-completed` | A `loop goal` run ended, with the outcome (reached, blocked, a guard) and round count. |
| `usage-limit` | A provider limit made the run stop (stop policy, or a wait that gave up) — includes the limit window and best-effort reset time. Waits that resume send nothing. |

Each entry in `webhooks`:

- `url` (required) — the endpoint. `${ENV_VAR}` references in url and header values resolve from the environment at send time, so tokens never live in the tracked config; a reference to an unset variable skips that webhook with a warning instead of sending a mangled request.
- `events` — optional subset filter; omitted means every event.
- `format` — `generic` (default) posts the full JSON event (event fields, usage summary, `costUsd` — null when no session reported cost — and a human-readable `message`); `slack` posts Block Kit for Slack-style incoming webhooks: a status emoji plus one bold headline, with cost/tokens/elapsed demoted to a context block beneath it, and a plain `text` fallback for clients that cannot render blocks. When a run parks issues for a human, the count and the `loop run --unblock` command are promoted *into* the headline, since that is the part a truncated phone notification reliably shows. The two renderings are separate code paths on purpose — Slack markup must never reach a generic consumer, which may be a pager or a parser.
- `headers` — optional extra headers (e.g. an Authorization bearer via `${TOKEN}`).

Delivery is fire-and-forget with a 5-second timeout per request; failures are console warnings and never stop a run. `--dry-run` sends nothing.

### Invocation lock

One mutating `loop run` / `loop review` / `loop fix-nits` / `loop polish` / `loop goal` per repo at a time, enforced by an advisory pid file at `.loop/lock.json` — concurrent invocations would race the rolling worktree and issue triage. Stale locks from crashed runs self-clear; a genuinely held lock fails fast with the holder's pid. Dry-runs are exempt.

### Safety model

- Agent work happens in the rolling loop worktree (or per-issue worktrees), never your checked-out branch; nothing is ever pushed automatically.
- Headless sessions run without interactive confirmation prompts (nobody's there to answer): `--permission-mode bypassPermissions` on Claude Code, `approval_policy=never` + the `workspace-write` sandbox on codex, `--trust --force` on cursor, `--allow-all-tools --allow-all-paths --no-ask-user` on copilot.
- The remote-action guard is **per-CLI, and not equally strong**:
  - `claude-code` — `git push`, `gh pr create/merge/close`, and `gh release` are explicitly denied via `--disallowedTools` on every session (denial applies even under bypassPermissions).
  - `copilot` — the same actions denied via `--deny-tool` patterns; copilot applies denial rules over every allow rule, including `--allow-all-tools`. Sessions are also never exported to GitHub web/mobile (`--no-remote-export`).
  - `codex` — the `workspace-write` sandbox's default-off network access blocks pushes and PR creation as a side effect.
  - `cursor` — **no equivalent guard exists**; nothing but the prompt stops a push. Configure cursor stages accordingly.
- These are safety boundaries, not knobs — there is no config to weaken them.

## Commands

### `loop run [project] [flags]`

Pick unblocked issues and run the full pipeline until none remain or you stop.

```bash
loop run --dry-run
loop run --once
loop run PRD-006
loop run --unblock PRD-006
loop run --max-parallel-runs 3
loop run --budget 50
```

Key flags: `--once`, `--dry-run`, `--unblock`, `--max-iterations`, `--budget`, `--no-worktree`, `--agent-cli`, `--model`, `--effort`, `--verify-cmd`, `--max-verify-cycles`, `--max-review-cycles`, `--max-parallel-runs`. Run `loop run --help` for the full list.

### `loop review [--fix] [flags]`

Batch review (and optionally fix) selected issues.

```bash
loop review --until PRD-002/issue-10
loop review --ids PRD-001/issue-01,PRD-002/issue-10
loop review --file .loop/review-queue.txt
loop review --fix --until PRD-002/issue-10
```

Review and fix sessions are fresh contexts, but they no longer start from zero. Each blocking review reports stable lower-kebab-case **finding family** ids and the invariant behind each family; a fresh blocking review without that structured ledger is rejected rather than silently bypassing convergence tracking. Loop persists valid families in each completed `review.json`, requires one complete `## Loop fix coverage` row per current family (invariant, central fix, sibling-case audit, and tests), and carries history from `.loop/runs/<project>/` into later review and fix prompts—even after an interrupted run is resumed. A missing/incomplete coverage matrix stops at the resumable `reviewFix` checkpoint without consuming another review cycle. Failed, interrupted, or structurally invalid review artifacts remain available for diagnosis but do not enter recurrence counts.

The first fix is already instructed to repair the shared invariant, audit sibling modes/types/error paths, and test adjacent cases rather than only the reviewer’s exact example. If the same family remains in a later review, Loop switches to **deep-fix mode**: the fixer sees historical family counts plus recent review summaries and coverage reports and must explain the incomplete approach through an explicit behavior matrix. Detailed prompt history is bounded; older events remain represented in aggregate counts. `maxReviewCycles` remains a safety bound, not the convergence strategy. If it is exhausted, the issue’s `## Loop escalation`, terminal output, and run result name families that both recurred and remain in the latest review. Older review artifacts without structured families remain readable and are marked as unstructured history.

### Goal mode (`loop goal`)

`loop run` works a human-curated backlog. `loop goal` removes it: you provide an outcome, and loop cycles **plan → drain → evaluate** rounds until a fresh session judges the goal reached.

```bash
loop goal "Migrate every API route to the new gateway client" --budget 50
loop goal --file ./goal.md --name gateway-migration
loop goal gateway-migration     # an exact slug resumes where it stopped
loop goals                      # list goals: status, rounds, backlog size
```

Each goal gets a slug (`--name`, or derived from the text) and a **goal folder** at `.loop/goals/<slug>/`: `goal.md` (the spec every session reads in place of a PRD), `issues/<slug>/` (agent-generated, standard loop issue format — the slug doubles as the project name), `verify/<issue-id>.cmd` (declared verify commands), `VERIFY.md` (shared verify knowledge), `evaluations/round-N.md`, and `rounds/` artifacts. Every stop — budget, round limit, ESC, usage limit — resumes with `loop goal <slug>`.

**One round:**

1. **Plan** (only when nothing is runnable): a fresh session in the rolling worktree — so it investigates the *merged* state — reads the goal, the previous round's gaps, `VERIFY.md`, and the existing backlog, then writes the smallest next batch of issue files (capped at `goal.maxIssuesPerRound`, default 5).
2. **Drain**: the regular pipeline works the backlog one issue at a time in the rolling worktree — same verify-fix/review cycles, evidence-based verify skip, webhooks. Escalations park the issue and the drain continues; hard failures stop the run.
3. **Evaluate**: loop mechanically re-runs every declared verify command against the merged state, then a fresh session judges the goal against the **observable repo state** (not issue checkboxes): `reached` exits 🏁, `not-reached` lists concrete gaps (fed verbatim into the next plan), `blocked` stops for a human.

**The verify contract inverts in goal mode.** There is no configured `verifyCmd`: each issue's implement session **chooses and declares** its gate (written to `verify/<issue-id>.cmd`, rationale appended to `VERIFY.md`), and loop executes exactly what was declared — as the issue's verify gate and again at evaluation. No declaration escalates the issue as **unverifiable**. Fix sessions may correct a wrong declaration (the file is re-read before every run), but weakening it to dodge a failure is a blocking review finding — the review session independently judges the declared command's adequacy against the diff.

**Verify failures self-heal, bounded.** A goal issue that exhausts its verify-fix cycles is retried once in a later round with a fresh fix budget (its `lastStage` checkpoint resumes it at the failing gate). A second exhaustion parks it `needs-human` so the next plan session can supersede it — the loop never grinds the same failing approach round after round.

**Escalations replan, within a budget.** When a goal issue escalates, the round finishes and the next plan session may **supersede** it (mark it `wontfix`, write a replacement with a genuinely different approach and a `Supersedes: <id>` line). Each original issue's lineage gets at most `goal.supersedeLimit` replacements (default 3; `--supersede-limit` overrides per invocation); failing past that budget stops the goal as `blocked` — repeated failures on the same problem need a human. A plan session that produces nothing runnable while gaps remain stops as `planner-stuck` — unless the following evaluation says `reached`, which exits cleanly.

There is **no default round limit** — `--round-limit` (or `goal.roundLimit`) bounds an invocation, `--budget` bounds reported spend, and loop warns loudly when a goal run starts with neither. `--on-session-limit` / `--on-weekly-limit` override the usage-limit policy for one goal invocation (see [Usage-limit handling](#usage-limit-handling)). Per-stage model/CLI/effort for the `plan` and `evaluate` sessions resolves through the regular `stages` config. Escalated goal issues are resumed by editing their issue file under the goal folder and re-running `loop goal <slug>`.

**Parallel goal drains.** With `maxParallelRuns` > 1 the drain runs through the same worker pool as `loop run`: unblocked issues execute concurrently in per-issue worktrees and merge back, with the post-merge re-verification using each issue's *declared* command. The plan session is told that dependencies drive parallelism — it links issues with `## Blocked by` only for real ordering constraints, slices work to minimize file overlap, and records the batch structure in the goal's `PLAN.md`. Goal issue files live under `.loop/goals/` (outside every worktree), so triage state needs no merging.

### `loop fix-nits`

Nits-only review verdicts don't block a merge, but their findings accumulate in `.loop/nits.md` under a per-issue heading so they don't scroll away. `loop fix-nits` runs one session (on the `reviewFix` stage's provider/model) over the whole file: it fixes or dismisses each entry, edits the file itself to remove addressed sections, reports decisions in a `## Loop nits decisions` block (persisted to the run dir as `decisions.json`), and commits after a final verify — which is skipped when the session already proved it in-stream. The batch is atomic: any failure (agent crash, unparseable decisions, failed verify) restores `nits.md` to its exact pre-session snapshot.

```bash
loop fix-nits --dry-run   # print the prompt
loop fix-nits
```

### `loop polish`

The wrap-up pass when a project is done: two sessions under one invocation.

```bash
loop polish PRD-006 --dry-run   # print the distill prompt
loop polish PRD-006
```

1. **fix-nits** — the same atomic batch as `loop fix-nits` (skipped when the backlog is empty). A failed nits phase stops the polish; the distill never runs on a tree the nits pass just broke.
2. **distill** — a fresh session promotes the project's shared notes (`.loop/notes/<project>.md`, plus the archived per-issue handoffs under `.loop/runs/<project>/*/handoff.md`) into the repo's tracked `CONTEXT.md` files — verifying each claim against the code before promoting it — then shrinks the notes file back down, passes verify, and commits (`doc: distill <project> notes into CONTEXT.md`). The distilled CONTEXT.md change is a normal commit on the rolling branch: review it like any other agent work before promoting.

Sends the `polish-completed` webhook either way.

### `loop archive <project>`

The sequel to `loop polish`. Once a project's nits are cleared and its notes are distilled into the repo's `CONTEXT.md`, everything the project owns moves under one dated folder:

```bash
loop archive PRD-006 --dry-run   # print the exact plan
loop archive PRD-006
```

```
<archiveDir>/2026-08-01-PRD-006/
  issues/            issues/PRD-006/
  runs/              .loop/runs/PRD-006/
  handoffs/          .loop/handoffs/PRD-006/
  notes.md           .loop/notes/PRD-006.md
  loop.project.json  the projects.PRD-006 config entry
```

**Nothing is deleted.** Reverting is moving the folder back; the only removals are directories the move left empty (`rmdirSync`, which refuses on anything non-empty). The config entry is written wrapped in a `projects` map, so the file is itself a valid partial config — restoring is a paste, not a transcription. `--dry-run` shares the same plan function as the real run, so preview and execution cannot disagree.

Loop refuses when `archiveDir` is unset, when the dated folder already exists, when another invocation holds the lock, or when **any issue is still runnable**. That last guard is against the scheduler's own runnable-role list, not "not done": an issue sitting at `needs-human` or `delegated` is waiting on a person and has usually been handled outside loop by the time someone retires the project — but if the next `loop run` would claim it, archiving really would bury live work. Human-parked issues are still named in the summary.

`archiveDir` has **no default** on purpose: archiving moves real directories, so loop refuses until a repo says where retired planning material belongs. It is the one value worth putting in the tracked config rather than the local overlay, since it is a shared convention.

### `loop list-runs`

Print recorded runs from `.loop/runs.jsonl`.

Every mutating invocation (`run`, `review`, `fix-nits`, `polish`, `goal`) stamps stdout/stderr lines with the local wall clock and tees the full console output — usage tables, stage durations, verification progress, limit waits, escalations — to `.loop/logs/<timestamp>-<command>.log` (ANSI-stripped), so closing the terminal loses nothing. Long external verification commands announce their start and emit progress at `heartbeatIntervalMs`.

**Line format.** Every line is `HH:MM:SS` local time plus a short prefix:

```
11:29:57 [16|implement] starting claude-code session (model=claude-opus-5; effort=high)
11:29:57 [16|implement] │ I'll start by reading the issue file and the shared notes.
11:29:57                │ Nothing in the debrief covers the export path yet.
11:29:58 [16|implement] │ → read: src/apps/data-export/AGENT.md
11:31:02 [16|implement] └ 8m41s · $6.11 · 7.6M tokens · peak context 171.2k
11:31:02 [loop] 3/5 workers active
```

- **`[<id>|<stage>]`** names the issue and the pipeline stage. The project is deliberately absent — it is constant for a whole run in the common case, and the run header already gives it in full. Only `review-round-6` shortens, to `review-6`: the word "round" adds nothing the number doesn't. `verify-fix-3` and `review-fix-2` keep their full names, because `verify-3` reads as the third verify rather than the third *fix cycle after* a failed one, and `fix-2` loses which loop it belongs to. Lines about no particular issue are just `[loop]`, whichever voice emitted them — a bare `[agent]` would claim an issue-less line came from a session.
- **Colour is keyed on the issue**, so every line about issue 16 — loop's own and the agent's — shares one colour, and scrolling a long run shows at a glance where each issue starts and ends. The key is the *qualified* id, so two projects' `issue-01` differ even though both print as `01`. Red and amber are excluded from that palette: they mean failure and caution elsewhere, and an issue that merely hashed to red would read as an issue in trouble.
- **The `│` gutter marks agent output.** Continuation lines of a multi-line message hold the prefix's column, so a session reads as one quoted block and loop's own lines break out of it. A bold `starting …` opens the rail and a `└` closes it with that stage's elapsed time, cost, tokens and peak context. It is a *character*, not a colour, precisely so the distinction survives `NO_COLOR` and the plain-text invocation log — which is where telling loop from the agent matters most.
- **Lines are wrapped at 180 columns, prefix and timestamp included.** Left to itself a terminal wraps at its own window edge and drops the overflow at column 0 with no prefix and no gutter, so one long sentence severs the rail. Loop wraps first, at word boundaries, hard-splitting only a "word" wider than the line (a URL, a stack frame). The budget counts the `HH:MM:SS` stamp the invocation log adds downstream, because that is what lands on screen. Agent stderr — the one stream nothing truncates — is wrapped the same way.
- **Tool traffic is cut at that same column, not wrapped.** A session emits hundreds of `→ shell: …` lines per stage, and one command spilling over four lines would bury every message between them — so each is truncated exactly where a wrapped line would have broken, giving cut lines and wrapped lines one right edge. Providers hand over whole summaries for that reason: only the display knows the prefix width, and a fixed guess upstream either overflows or leaves the line short. An exit code or failure reason is kept out of the cut, since it says more than the last few characters of a long command.
- **Decisions get a badge**: a solid colour block, coloured by what it means — red failed, amber needs a look, green succeeded, cyan is a neutral marker. Review verdicts, the iteration header, and the run's final state all carry one, so scrolling past thousands of lines still surfaces the handful that decided something. Under `NO_COLOR` a badge degrades to its bare upper-case label rather than leaving stray padding. The label is bold over a foreground pinned to palette index 16, outside the legacy 0–15 range: bold combined with one of the basic 30–37 foregrounds is the old "use the bright variant" signal, which iTerm2, Terminal.app and VS Code honour by default, and it would render the black label grey on the block. Backgrounds stay basic ANSI so they follow your terminal theme.

**Staying awake.** On macOS loop holds a `caffeinate -i` sleep inhibitor for the whole invocation and says so on the first line, because an unattended run that sleeps two hours in is as lost as one that sleeps through a usage-limit wait. The inhibitor is tied to loop's own pid, so a crash releases it and no process is left holding the machine awake. `--no-caffeinate` (or `"keepAwake": false`) turns it off; other platforms are a no-op.

**Console styling.** A run is otherwise a uniform wall of text in which the review verdict — the one line deciding an issue's fate — carries the same weight as hundreds of tool-call echoes. Loop styles by *meaning*, not colour (`src/logs/style.ts`): verdicts get a solid colour badge, stage starts are bold, agent prose stays plain, tool traffic and log paths dim, failures are red, and waits and retries are amber. Cost and usage totals are deliberately **not** dimmed — a session emits hundreds of tool lines and a handful of cost lines, and cost is what you read to decide whether to keep going; only the per-stage breakdown recedes. Styling honours `NO_COLOR` and `FORCE_COLOR`, otherwise follows stdout; nothing styled reaches an artifact, since the invocation log strips ANSI and stream logs are written from raw provider output.

Loop's fallback commits exclude both configured `commitExcludePaths` and paths that were already dirty when the run began. This protection is path-level: Loop leaves the complete pre-existing path uncommitted rather than trying to mix user and agent hunks from the same file.

```bash
loop list-runs
```

### `loop completion <bash|zsh>`

Print an installable completion script:

```bash
eval "$(loop completion zsh)"   # add to ~/.zshrc
eval "$(loop completion bash)"  # add to ~/.bashrc
```

## Stopping a run

Three gestures, escalating in how much unfinished work they discard:

| Gesture | Effect |
| ------- | ------ |
| **ESC** | Claim nothing more; the in-flight issue finishes its whole pipeline first. |
| **ESC again** | Also stop at the next **stage boundary**, parking the in-flight issue at its checkpoint. |
| **Ctrl+C ×2** | Force-stop now, killing every active agent process tree. |

The second level exists because "finish the current issue" can still mean twenty more minutes and half a dozen sessions on a verify-heavy issue. Parking is graceful in the strict sense: loop already starts a fresh session at every stage boundary and carries continuity only on disk, so stopping there discards exactly what an ordinary stage transition discards — the bookkeeping is identical to a usage-limit interruption because it is the same situation. The issue is left `agent-interrupted` with a `lastStage` checkpoint, the run ends with `stopped-by-user` (exit 0, not a failure banner), and the next `loop run` picks it up where it stopped.

The boundaries are: after implement (checkpointed at `verifyFix`, so the resume proceeds to the gate rather than re-implementing), after any verify-fix cycle whose gate still fails, after a review that requested changes (checkpointed at `reviewFix` — the findings are already persisted, so the resume skips a second review of the same tree), and after each review-fix round. There is deliberately **no** boundary between a clean review and the merge: the merge takes seconds, and re-entering there would pay for a second review of an unchanged tree. In parallel runs the pool stops claiming and every in-flight worker gets to its own boundary.

Further ESC presses just re-confirm — there is no third level, and no time window between presses, since requiring a double-tap would only punish pressing once and then wanting out sooner.

> **Caveat:** verify and review cycle counters are not persisted, so a resumed issue gets a fresh `maxVerifyCycles`/`maxReviewCycles` budget. Uncommitted session work keeps today's behaviour — edits stay in the worktree and the resumed stage inherits a dirty tree.

## Resuming failed issues

Loop records `lastStage` (`implement` | `verifyFix` | `review` | `reviewFix`) in issue frontmatter when work begins on each stage. On re-pick, any runnable issue with a checkpoint resumes at that stage instead of restarting implement. This includes a human resetting an escalated issue to `ready-for-agent`.

**Force a full restart:** remove `lastStage` from the issue frontmatter, then set `triage` to a runnable label such as `ready-for-agent` (or loop's default `ready`).

### `--unblock`

Issues escalated to `needs-human` / `ready-for-human` are not runnable until a human edits triage. `loop run --unblock` (optionally project-filtered) flips them back to the failure role matching `lastStage` so loop can retry where it left off:

```bash
loop run --unblock --dry-run   # preview transitions
loop run --unblock
```

## Issue tracker conventions

Loop expects markdown issues with YAML frontmatter:

- **Project folder** — every issue file lives directly under `issuesDir/<project>/` (e.g. `issues/PRD-006/`). The folder name is the issue's `project`. Flat files directly in `issuesDir` are rejected.
- **Local `id`** — unique only within the project folder (e.g. `issue-07`). Not required to be globally unique.
- **`qualifiedId`** — `${project}/${id}` (e.g. `PRD-006/issue-07`) used in logs, branches, CLI targeting, and handoff paths.
- **`triage:`** — current triage label (see [Triage vocabulary](#triage-vocabulary))
- **`lastStage:`** — optional resume checkpoint (set by loop)
- **`prd:`** — optional override for which PRD doc to surface (identity still comes from project folder)
- **`## Blocked by`** — dependency list; bare ids resolve within the same project (`issue-02`), qualified ids for cross-project (`PRD-003/issue-04`). Entries are also accepted as markdown links, backticked filenames, and repo-relative paths (`[issue-02](issue-02.md)`, `` `issue-02.md` ``, `issues/PRD-003/issue-04.md`), with any trailing prose ignored — each is reduced to an id and matched against issues that actually exist. A reference matching no known issue keeps its dependent blocked and is reported at startup, since a typo would otherwise stall the backlog silently.
- **Acceptance criteria** — `- [ ]` / `- [x]` checkboxes under `## Acceptance criteria`

CLI `--ids` / `--until` accept qualified ids or an unambiguous bare local id.

### Shared context files

Loop keeps three layers of durable context, from narrowest to widest:

- **Per-issue handoff** (`.loop/handoffs/<project>/<id>.md`) — narrative between one issue's stages (implement/fix sessions read and write it; review never sees it). A fix prompt presents current review/verification feedback first and labels the older handoff as historical; Git and current feedback are authoritative. When Loop creates a fallback commit after the agent exits, it records that commit in the handoff so stale “unstaged” notes cannot be mistaken for current state. The handoff is archived into the run dir as `handoff.md` on completion, then cleared.
- **Per-project notes** (`.loop/notes/<project>.md`) — the agents' shared working memory across all of a project's issues: system/testing quirks, verify noise, where conventions live. Every pipeline stage reads it; implement and review sessions update it (fix passes are narrow and read-only; unbounded writers would balloon it). Sessions are told to correct stale entries rather than append forever.
- **Repo `CONTEXT.md`** — reviewed, tracked knowledge in the codebase itself. `loop polish` distills the project notes into it when a project wraps up.

Example frontmatter:

```yaml
---
id: issue-07
title: Per-task-type timeouts
triage: ready-for-agent
---
```

