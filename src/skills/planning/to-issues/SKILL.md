---
name: to-issues
description: Create local Markdown issues that Loop can discover from a plan, spec, or conversation, with verifiable slices, dependencies, and human-owned work. Use when explicitly asked to create or publish issues; this does not start implementation.
---

# To Issues

Break a plan, spec, or conversation into a set of **issues** — tracer-bullet vertical slices, each declaring the issues that **block** it.

## Loop output contract

Read [the Loop planning contract](../to-spec/references/loop-planning.md) before drafting. This bundle installs `to-spec` alongside this skill, so the reference is available. It defines paths, frontmatter, exact dependency IDs, configured triage labels, and the handoff to Loop. Preserve the existing dated project ID and spec path. By default, create issues beside the spec in `specs/<YYYYMMDD>-<project-slug>/issues/`; reuse the spec's original date when continuing work.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments. If no spec exists and the user requested issues only, omit `spec` and put the necessary requirements and testing decisions in each issue; do not invent a spec link or create an unrequested spec.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Issue titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

**Each issue is read alone.** Loop supplies that file and its linked spec, but the session has no memory of this conversation or earlier issues. Whatever it needs to do the work has to be written in its own file.

That makes referencing another issue a matter of writing, not linking. A `## Blocked by` entry establishes an ordering; it does not tell the reader what the other issue built. So if this slice depends on a name, an interface, a schema column, or a decision established elsewhere, say what it is here, in words — "the `OrderTotal` type introduced by 03, in cents" — rather than pointing at the issue that holds it and assuming someone will follow the link. Write the same way about work that has already landed: an agent joining halfway through has no memory of the issues that came before it.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first
- An instruction addressed to a fresh-context agent has to live in the issue that agent opens. Cross-issue coordination goes in both files or it isn't coordination — and if it's meant to be enforced, it belongs in acceptance criteria, not Comments.
- Every acceptance criterion on a `ready` issue must be **verifiable by the agent alone** — see below. A slice whose completion only a human can judge is not a `ready` slice.

</vertical-slice-rules>

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

#### Acceptance criteria must be agent-verifiable

An unattended agent ticks these boxes itself, with no one to ask. So every `- [ ]` must be something that agent can settle by running a project command and reading the result — a named test passing, a command exiting zero, a file or endpoint containing a specific value, a type check succeeding. Write the criterion so the verifying command is obvious from the text.

Reject anything resting on human judgement or human access: "the UI looks right", "performance feels acceptable", "the copy reads well", "verified against the vendor sandbox", "the team signs off". An agent handed one of these either stalls or ticks it blind, and a blindly-ticked box is worse than a missing one — it makes an unfinished issue look finished.

#### Split human-only work into its own issue

If the spec has a `## Human-Only Work` section, every entry in it becomes one of these issues — start there, then add anything the slicing itself turns up.

When a slice genuinely needs a person — a visual or UX judgement, a credential or vendor account, a check on real hardware, a stakeholder decision — do **not** bury it as a criterion inside an agent issue. Give it its own issue with frontmatter `triage: delegated` (or the configured `delegatedToHuman` label), describing exactly what the person must do and what evidence closes it. Then have the agent issue name it under `## Blocked by`.

This is a real edge, not a note: Loop never claims delegated issues, and treats a dependency as satisfied only when the blocker is `done` — so the agent work waits for the person rather than guessing, and a run with waiting agent issues reports `blocked`. A remainder consisting only of delegated work is settled from Loop's perspective. Once the human has done the work, they set that issue to `done` and the dependent issue becomes claimable on the next round.

Prefer splitting to weakening. If a slice is half agent-verifiable and half not, cut it along that line into two issues rather than softening the criteria until the whole thing passes unattended.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. Loop verifies each issue before it lands. If batches cannot pass independently, improve the expand step or keep inseparable work in one bounded issue. Do not defer the first green verification to a final integration ticket or assume Loop supports per-issue integration branches.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this issue makes work

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct — does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?
- For any work you have split out as `delegated`: is that genuinely yours to do, and is the evidence that closes it stated precisely enough?

Also state, for each `ready` ticket, the command or check that settles its acceptance criteria. If you cannot name one for a criterion, that criterion is not agent-verifiable — rewrite it or split it out before publishing.

Resolve material open decisions with the user before publication. If the user already approved the plan or requested direct issue creation, use that authorization and publish the concrete breakdown without another approval round.

### 5. Publish the issues to the issue tracker

For each approved slice, publish a new issue to the issue tracker. Use the issue body template below. These issues are considered ready for AFK agents, so publish them with the correct triage label unless instructed otherwise.

Publish issues in dependency order (blockers first) so you can reference real issue identifiers in the "Blocked by" field.

Start each file with `id`, `title`, `triage`, and `spec` frontmatter, using the configured labels from the planning contract. Use the same ID as the filename stem. The values below illustrate defaults; replace them with the real slice and exact spec path.

<issue-template>
---
id: NN-slug
title: <Title>
triage: ready
spec: specs/<YYYYMMDD>-<project-slug>/spec.md
---

## Parent

A reference to the parent issue on the issue tracker (if the source was an existing issue, otherwise omit this section).

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Acceptance criteria

Two to six boxes, each settleable by the agent alone by running something and reading the result. Name the observable, not the feeling.

- [ ] `<command>` passes, covering <the behaviour this slice adds>
- [ ] <endpoint/module> returns <specific value> for <specific input>
- [ ] <existing suite> still passes

## Blocked by

- <exact blocking issue ID, if any>

Or "None - can start immediately" if no blockers.

</issue-template>

For work you split out under "Split human-only work into its own issue", publish it with this template instead. It sits in the same directory and numbering sequence as every other issue — only its status differs.

<delegated-issue-template>
---
id: NN-slug
title: <Title>
triage: delegated
spec: specs/<YYYYMMDD>-<project-slug>/spec.md
---

## What to do

The task, addressed to a person: what to do, where, and with what access. Be specific enough to act on cold — this is read by whoever picks it up, not by whoever wrote it.

## Done when

The evidence that closes this issue — the artifact produced, the value recorded, the place a credential now lives. Whoever finishes it sets this issue's status to `done`, which is what releases the issues blocked on it.

## Blocked by

- <exact blocking issue ID, if any>

Or "None - can start immediately" if no blockers.

</delegated-issue-template>

Do NOT close or modify any parent issue.

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

### 6. Validate and hand off

Check each file against the planning contract: frontmatter ID and title, configured triage label, an existing spec path when `spec` is present, exact dependency targets, and no cycles. Every ready issue needs agent-verifiable acceptance criteria and enough context to stand alone. Preserve human-approved testing decisions from the spec.

Report the dated project ID, spec path, scan root and exact issue directory, and human-owned or unresolved blockers. Tell the user to run `loop init` to review discovered projects and suggested paths, then `loop run <project-id> --dry-run` to inspect selection. Loop discovers issues in its configured root even without a project override. Do not start implementation as part of publishing.
