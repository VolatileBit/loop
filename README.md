# loop

**Give a coding agent your to-do list. Walk away.**

Write tasks as markdown files. Loop works through them one at a time with an AI coding agent.

Every task gets checked before it lands: your tests must pass, and a second agent reviews the code. Failures get fixed and retried. Anything it can't solve is flagged for you.

It runs unattended — overnight, over a weekend, or while you're in meetings.

```
   pick a task
        ↓
    implement ←──┐
        ↓        │
      verify     │  fix and retry
        ↓        │
      review ────┘
        ↓
      commit
        ↓
    next task
```

---

## Why you'd use it

- **A backlog, not a chat.** No babysitting one prompt at a time.
- **Nothing merges unchecked.** Your own test command is the gate. A separate review agent reads the diff.
- **It works in a sandbox.** All work happens in a separate git worktree, never your checked-out branch. Nothing is ever pushed.
- **It knows when to stop.** Stuck tasks are labelled and left for you, with notes on what it tried.
- **Costs are capped.** Set a dollar limit. It stops claiming new work when hit.

## Requirements

| | |
|---|---|
| **Node.js** | 20 or newer |
| **git** | the target directory must be a git repo |
| **An agent CLI** | at least one of `claude`, `codex`, `cursor`, `copilot` — installed and logged in |

## Install

```bash
git clone https://github.com/VolatileBit/loop
cd loop
npm install
npm link
```

Check it worked:

```bash
loop --help
```

To remove: `npm uninstall -g @polyweave/loop`

## Quick start

From any git repo you want loop to work on:

**1. Set it up**

```bash
loop init
```

Asks a few questions (which agent, how to run your tests, where tasks live) and writes `loop.config.json`. It inspects your repo first and suggests answers.

**2. Write a task**

Create `issues/my-project/issue-01.md`:

```markdown
---
id: issue-01
title: Add a --version flag to the CLI
triage: ready
---

## Acceptance criteria

- [ ] `mytool --version` prints the version from package.json
- [ ] Covered by a test
```

**3. See what it would do**

```bash
loop run --dry-run
```

**4. Run one task**

```bash
loop run --once
```

**5. Let it work the whole list**

```bash
loop run
```

## What a run looks like

```
11:29:57 [01|implement] starting claude-code session (model=claude-opus-5)
11:29:57 [01|implement] │ I'll start by reading the issue file and the shared notes.
11:29:58 [01|implement] │ → read: src/cli/args.ts
11:31:02 [01|implement] └ 8m41s · $6.11 · 7.6M tokens
11:31:02 [01|verify]    npm test — passed
11:34:19 [01|review]    VERDICT: nits-only
11:34:21 [01|complete]  committed · issue-01 done
```

Everything is also written to `.loop/logs/`, so closing the terminal loses nothing.

## Commands

| Command | What it does |
|---|---|
| `loop run` | Work the backlog until nothing's left |
| `loop run --once` | Do one task, then stop |
| `loop run --dry-run` | Show what it would pick, change nothing |
| `loop run <project>` | Only work tasks in one folder |
| `loop run --budget 50` | Stop claiming new work past $50 |
| `loop goal "..."` | No backlog — describe an outcome, loop writes its own tasks (see [Goal mode](#goal-mode)) |
| `loop review --fix` | Re-review (and fix) tasks already done |
| `loop fix-nits` | Clear the backlog of minor review comments in one pass |
| `loop polish <project>` | Wrap up a project: clear nits, write up what was learned |
| `loop archive <project>` | Retire a finished project into a dated folder |
| `loop list-runs` | Show past runs |
| `loop init` | Guided setup |
| `loop completion zsh` | Tab completion (`bash` also supported) |

Add `--help` to any of them for the full flag list.

## Stopping a run

| Press | What happens |
|---|---|
| **ESC** | Finish the current task, then stop |
| **ESC** again | Stop at the next safe point, saving progress |
| **Ctrl+C** twice | Stop right now |

Stopped tasks keep a checkpoint. The next `loop run` picks them up where they left off.

## Writing tasks

Tasks are markdown files in `issues/<project>/`. One folder per unit of work — a feature, a refactor, a `hotfixes` bucket.

```markdown
---
id: issue-07
title: Per-task-type timeouts
triage: ready
---

## Blocked by

- issue-03

## Acceptance criteria

- [ ] Each task type reads its own timeout
- [ ] Defaults unchanged when not configured
```

| Field | Meaning |
|---|---|
| `id` | Unique inside its folder. `issue-07` is fine. |
| `title` | What it is |
| `triage` | Current state — `ready` means loop may pick it up |
| `## Blocked by` | Won't start until those tasks are done |
| `## Acceptance criteria` | What "done" means |

### Task states

Loop moves tasks between these as it works:

| Label | Meaning |
|---|---|
| `ready` | Loop can pick this up |
| `in-progress` | Being worked on now |
| `done` | Passed tests and review |
| `needs-human` | Loop got stuck — read its notes and decide |
| `needs-info` | The task isn't clear enough to start |
| `verify-failed` | Tests kept failing |
| `delegated` | You took it over. Loop stops counting it as outstanding. |
| `wontfix` | Not doing it |

Stuck on something? Fix the cause, then:

```bash
loop run --unblock
```

That puts `needs-human` tasks back in the queue, resuming where they stopped.

## Configuration

`loop.config.json` at your repo root. Only one field is required.

```json
{
  "agentCli": "claude-code",
  "verifyCmd": "npm run typecheck && npm test",
  "issuesDir": "issues"
}
```

| Field | Default | What it does |
|---|---|---|
| `verifyCmd` | — | **Required.** The command that proves the work is good. Your tests. |
| `agentCli` | `cursor` | `cursor`, `claude-code`, `codex`, or `copilot` |
| `model` | `auto` | Model to use |
| `effort` | — | Reasoning effort. Not supported on cursor. |
| `issuesDir` | `issues` | Where tasks live |
| `maxVerifyCycles` | `3` | Fix attempts before giving up on tests |
| `maxReviewCycles` | `3` | Fix attempts before escalating to you |
| `maxParallelRuns` | `1` | Tasks at once, each in its own worktree |

`loop.config.example.json` in this repo shows every available option.

**Machine-specific settings** go in `loop.config.local.json` (gitignore it). Read over the top of the tracked config — handy for local paths and tokens.

<details>
<summary><b>Different agents for different stages</b></summary>

Use a cheap model to write code and an expensive one to review it:

```json
{
  "agentCli": "cursor",
  "stages": {
    "implement": { "agentCli": "claude-code", "model": "sonnet-5", "effort": "high" },
    "review":    { "agentCli": "codex", "model": "gpt-5.5", "effort": "xhigh" }
  }
}
```

Stages: `implement`, `verifyFix`, `review`, `reviewFix` (plus `plan` and `evaluate` in goal mode).

Effort levels differ per provider:

| Provider | Allowed values |
|---|---|
| `claude-code` | `low`, `medium`, `high`, `xhigh`, `max` |
| `codex` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `copilot` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `cursor` | not supported |

</details>

<details>
<summary><b>Falling back when you hit a usage limit</b></summary>

```json
{
  "agentCli": "codex",
  "fallbackAgents": [
    { "agentCli": "claude-code", "model": "opus-5" },
    { "agentCli": "copilot" }
  ]
}
```

Hit a provider limit, loop moves down the list instead of stopping. It remembers which providers are limited and skips them until they reset.

Only usage limits trigger this — crashes and ordinary errors don't.

If every provider is limited, `usageLimits` decides what happens:

```json
{ "usageLimits": { "session": "wait", "weekly": "stop" } }
```

- **`wait`** — sleep until the limit resets, then carry on. Keeps the machine awake on macOS.
- **`stop`** — end the run (exit code 2) and fire a webhook so you hear about it.

</details>

<details>
<summary><b>Per-project settings</b></summary>

Different test commands for different parts of a monorepo:

```json
{
  "verifyCmd": "pnpm verify",
  "projects": {
    "PRD-006": { "verifyCmd": "pnpm --filter @org/web run verify", "prd": "docs/prd/PRD-006-web.md" },
    "hotfixes": { "verifyCmd": "pnpm test" }
  }
}
```

A project can override `verifyCmd`, `model`, `effort`, `env`, `preflight`, `usageLimits`, and which design doc gets shown to the agent.

</details>

<details>
<summary><b>Running several tasks at once</b></summary>

```json
{ "maxParallelRuns": 3 }
```

Each task gets its own worktree, then merges back. If two tasks touch the same files and the merge breaks, that task is flagged `needs-human` and the rest keep going.

</details>

<details>
<summary><b>Environment and readiness checks</b></summary>

```json
{
  "env": { "NX_DAEMON": "false" },
  "preflight": {
    "cmd": "pg_isready -q",
    "message": "start the dev database: `docker compose up -d db`"
  }
}
```

- **`env`** — added to the environment for every agent session and test run.
- **`preflight`** — checked before picking up each task. Fails, and the run stops with your message. Stops loop grinding through a backlog when your database is down.

Loop never *starts* anything itself — it only checks.

</details>

<details>
<summary><b>Notifications</b></summary>

```json
{
  "webhooks": [
    {
      "url": "${SLACK_WEBHOOK_URL}",
      "format": "slack",
      "events": ["run-completed", "issue-escalated", "usage-limit"]
    }
  ]
}
```

Events: `issue-completed`, `issue-escalated`, `run-completed`, `fix-nits-completed`, `polish-completed`, `goal-completed`, `usage-limit`.

`${VARS}` resolve from the environment at send time, so tokens stay out of git. `format` is `generic` (JSON) or `slack` (Block Kit).

</details>

<details>
<summary><b>Custom task labels</b></summary>

If your team already says `ready-for-agent` instead of `ready`:

```json
{
  "triageLabels": {
    "readyForAgent": "ready-for-agent",
    "done": "agent-done"
  }
}
```

Any label loop doesn't recognise is reported at startup rather than silently ignored — a typo would otherwise drop a task off the backlog with nothing said.

</details>

<details>
<summary><b>Built-in TDD and review workflows</b></summary>

```json
{ "tddSkill": "builtin", "reviewSkill": "builtin" }
```

Embeds loop's own TDD and two-axis review workflows into every prompt. Same behaviour across all four agent CLIs, nothing to install.

Point them at your own skill instead if you have one: `"reviewSkill": "/review-work"`.

</details>

## Goal mode

No backlog? Describe the outcome instead.

```bash
loop goal "Migrate every API route to the new gateway client" --budget 50
loop goals                    # list goals and their progress
loop goal gateway-migration   # resume where it stopped
```

Loop cycles **plan → work → evaluate**: it writes its own tasks, works through them, then a fresh agent judges whether the goal is actually met by looking at the code — not at ticked checkboxes. Not there yet, it plans another round.

Since there's no test command defined up front, each task picks and declares its own — and the reviewer checks that choice is honest.

Always give it `--budget` or `--round-limit`. Loop warns if you give neither.

## Safety

- Work happens in a **separate git worktree**, never your checked-out branch.
- **Nothing is ever pushed.** No PRs opened, no releases cut.
- `git push`, `gh pr create`, and `gh release` are **explicitly blocked** for `claude-code` and `copilot`. On `codex` the sandbox blocks network access as a side effect.
- ⚠️ **cursor has no equivalent block** — only the prompt stops it. Bear that in mind when configuring cursor stages.
- One loop per repo at a time, so two runs can't fight each other.
- These are boundaries, not settings. There's no config to weaken them.

## Good to know

**It won't run your tests twice.** If the agent already ran your exact test command and it passed, loop skips its own run. Anything that could have changed files afterwards, and it runs them again properly.

**It remembers between sessions.** Notes accumulate per project — testing quirks, where conventions live — and get passed to later tasks. `loop polish` promotes the durable parts into your repo's `CONTEXT.md`.

**Minor review comments don't block.** They collect in `.loop/nits.md`. Clear them whenever with `loop fix-nits`.

**Interrupted work resumes.** Every task records which stage it reached. Picked up again, it continues from there rather than starting over.

## Development

```bash
npm test          # unit tests
npm run typecheck
npm run test:e2e  # drives the real agent CLIs — spends real quota
```

`LOOP_E2E_CLIS=claude-code,codex npm run test:e2e` narrows the matrix.

## License

MIT
