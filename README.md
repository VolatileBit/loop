# Loop

**Plan with your coding agent. Let Loop work through the backlog.**

Loop takes a set of local issues and drives a coding agent through implementation, verification, and code review. It retries failures, saves progress between runs, and flags work that needs your input.

The included planning skills turn your idea into a spec and issues that Loop can read. You don't need to write their file formats by hand.

## Get started

You'll need **Node.js 22.13+**, a Git repository, and at least one supported coding agent CLI installed and logged in: **Claude Code, Codex, Cursor, or Copilot**.

### 1. Install Loop and the planning skills

```bash
npm install -g @polyweave/loop
cd your-project
loop install planning-skills
```

Choose **project** to install skills for this repository, or **user** to install them in your home directory for use across projects. The installer prints where it puts the files. It supports all four agents by default and includes rulesync, so there's nothing else to install.

Open a new coding-agent session in your project so it can discover the installed skills.

### 2. Plan with your coding agent

In your coding agent, type `/` followed by the skill name and describe what you want to build:

- **Small to medium projects:** use `/grilling` to work through the plan, or `/grill-with-docs` to also record decisions and shared terminology.
- **Complex, large projects:** use `/wayfinder` to map the work and resolve planning decisions one at a time.

For example:

```text
/grill-with-docs I want users to preview images before uploading them.
```

Once planning is done, save the agreed spec:

```text
/to-spec
```

Then generate implementation issues from it:

```text
/to-issues
```

The skills create the spec, issue links, acceptance criteria, and dependencies. By default, they save everything together:

```text
specs/YYYYMMDD-project-slug/
  spec.md
  issues/
    01-first-task.md
    02-next-task.md
```

You can request a custom location. The skills also respect existing project configuration.

### 3. Configure Loop

Back in your terminal:

```bash
loop init
```

Choose your agent and the command that verifies your project, such as `npm test`. Loop discovers the planning files and unregistered projects, then offers paths you can accept or replace. It saves the settings in `loop.config.json`.

To skip the optional agent survey and use filesystem suggestions only, run `loop init --no-discovery`.

Review and commit the spec, issues, and configuration before running Loop. Its default worktree starts from your current branch's committed files:

```bash
git add specs/ loop.config.json
git commit -m "Add implementation plan and Loop configuration"
```

Use your chosen planning path instead of `specs/` if you changed it.

### 4. Run your first task

```bash
loop run --dry-run   # preview which task Loop would pick
```

Loop normally creates a sibling working directory named `<repo>-loop`, on the branch `loop/rolling/<your-branch>`. Check the startup output for the actual working directory and install your project's dependencies there if needed.

From your original checkout, run one task:

```bash
loop run --once      # implement, verify, and review one task
```

When you're ready to work through the remaining backlog:

```bash
loop run
```

Review the resulting changes, then merge that branch into your original branch when you're satisfied. Logs and run state stay in `.loop/` in your original checkout.

## Using the planning skills

Loop's skills are adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills), with changes for Loop's planning and execution workflows.

Use the planning commands first, then `/to-spec` → `/to-issues`:

| Skill | Use it to… |
|---|---|
| `/grilling` | Plan a small to medium project by challenging assumptions |
| `/grill-with-docs` | Plan a small to medium project while recording decisions and terminology |
| `/wayfinder` | Plan a complex, large project through a map of decisions |
| `/to-spec` | Save the completed plan as a specification |
| `/to-issues` | Generate verifiable issues with dependencies from the spec |
| `/domain-modeling` | Establish shared domain terms and architectural decisions |

To choose the installation scope or agents explicitly:

```bash
loop install planning-skills --scope user --targets claudecode,codexcli
loop install planning-skills --scope project
```

| Agent target | Project location | User location |
|---|---|---|
| `claudecode` | `.claude/skills/` | `~/.claude/skills/` |
| `codexcli` | `.agents/skills/` | `~/.agents/skills/` |
| `cursor` | `.cursor/skills/` | `~/.cursor/skills/` |
| `copilot` | `.github/skills/` | `~/.copilot/skills/` |

Without a terminal, installation defaults to project scope. Use `--dry-run` to preview destinations. Existing identical files are skipped; conflicting files require `--force` to replace. After updating Loop, run the installer again to refresh the skills.

For custom tooling or manual authoring, see the [planning format reference](src/skills/planning/to-spec/references/loop-planning.md).

## Everyday commands

| Command | What it does |
|---|---|
| `loop run` | Work through available tasks |
| `loop run --once` | Process one task |
| `loop run --dry-run` | Preview task selection |
| `loop run <project>` | Work on one project; use its full dated folder name |
| `loop run --unblock` | Retry `needs-human` tasks after you've addressed the cause |
| `loop review --fix` | Re-review completed work and fix findings |
| `loop fix-nits` | Address accumulated minor review comments |
| `loop polish <project>` | Clear nits and record project learnings |
| `loop archive <project>` | Archive a finished project and its planning files |
| `loop list-runs` | Show past runs |

Use `loop --help` or `loop <command> --help` for more options.

**Pause and resume:** press **ESC** to finish the current task and stop. Press it again to stop at the next safe point. **Ctrl+C twice** stops immediately. Run `loop run` again to resume saved progress.

**Usage limits:** by default, Loop waits for session limits to reset and stops on weekly limits. Change this with `usageLimits` in your configuration.

**Work that needs you:** inspect the issue and its notes when Loop flags it. Resolve missing decisions or failed checks before retrying. Human-owned issues remain with you; dependent tasks wait for them to be completed.

## Configuration

`loop init` handles the initial setup. For later changes, edit `loop.config.json`; put machine-specific overrides in a gitignored `loop.config.local.json`.

The [example configuration](loop.config.example.json) covers models, agents per stage, parallel tasks, dependency installation, provider fallback, notifications, and custom task labels. Use `loop init --help` for setup flags.

New projects use `specs` as both the spec and issue scan root. Existing custom paths and older layouts remain supported. Run `loop init` after adding a planning project to discover it; existing configured paths are preserved.

Loop's built-in TDD, review, and handoff guidance ships with the runtime. The planning-skills installation is for the agent you plan with.

## Start from a goal instead

For work where you want Loop to generate its own tasks:

```bash
loop goal "Migrate API routes to the new gateway client" --round-limit 5
loop goals
```

Loop repeats planning, implementation, and evaluation until the goal is met or the round limit is reached. Use the goal ID shown by `loop goals` to resume it with `loop goal <id> --round-limit 5`. Set a round limit: there is no default limit.

## Development

```bash
git clone https://github.com/VolatileBit/loop
cd loop
npm install
npm link
npm test
npm run typecheck
```

`npm run test:e2e` uses real agent CLIs and consumes quota. Set `LOOP_E2E_CLIS=claude-code,codex` to narrow the agents tested.

Maintained skills live in [`src/skills/`](src/skills/): `planning/` contains the installable planning bundle, `runtime/` contains the built-in workflows, and `explaining/` contains generic explanation skills. All ship in the npm package. `skill-bundles/` is ignored and is not used or packaged by Loop.

## License

MIT
