---
name: to-spec
description: Synthesize an agreed plan or conversation into a local Markdown specification that Loop can use. Use when asked to write or publish a spec; this does not start implementation.
---

# To Spec

Turn the conversation and repository evidence into a specification. Synthesize existing decisions; do not start another interview or invent requirements to fill a template.

Read [the Loop planning contract](references/loop-planning.md) to resolve the dated project ID, destination, and issue handoff. Read applicable domain glossaries and ADRs before writing. Prefer existing `CONTEXT.md` terminology; respect a repository that already uses another glossary name.

1. Confirm the current behavior from relevant code, tests, and documentation. Surface contradictions that affect the plan.
2. Identify the public interfaces where tests can observe the requested behavior. Preserve already agreed testing decisions. When the conversation has not settled a choice, record a repository-grounded proposal as a proposal, not as human approval. A material unresolved decision belongs under open questions and keeps dependent issues out of `ready`.
3. Write or update the spec at the resolved path, defaulting to `specs/<YYYYMMDD>-<project-slug>/spec.md`. Scale detail to the work; include only requested behavior and decisions needed to implement it.
4. Report the saved path, dated project ID, and any open questions. Creating a spec does not authorize generating issues or running Loop.

## Spec structure

Start with `# <Feature title>`, then use:

- `## Problem Statement`: the user problem and evidence of current behavior.
- `## Solution`: the intended outcome and observable behavior.
- `## User Stories`: the relevant actors, capabilities, and benefits, without speculative extensions.
- `## Implementation Decisions`: settled interfaces, constraints, invariants, and trade-offs. Include precise contracts or small prototype excerpts when prose would lose meaning. Use paths only where they identify a necessary artifact or existing boundary.
- `## Testing Decisions`: preserve this exact heading. Name agreed public test boundaries and what they prove; distinguish agreed decisions from inferred proposals. Point to existing test patterns and verification commands when known. Avoid prescribing tests of internal structure.
- `## Human-Only Work`: each action requiring human judgment or access, and the evidence that closes it. Write `None` if there is none. Issue creation splits these into human-owned blockers.
- `## Out of Scope`: explicit exclusions.
- `## Open Questions`: unresolved decisions and which work they block, or `None`.

The spec is context, not an executable issue: do not add issue `id` or `triage` frontmatter to it. Keep requirements self-contained enough for a fresh implementation session to understand them without this conversation.
