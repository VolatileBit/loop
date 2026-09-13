---
name: loop-handoff
description: Preserve concise issue context for the next unattended Loop stage. Use when the runner requests a closing handoff or a planning session explicitly seeds shared project notes.
---

# Loop handoff discipline

A fresh session has no memory of this one. Leave enough context to continue: what changed, decisions and assumptions with reasons, chosen test boundaries, checks actually run and their results, current state, incomplete criteria, and the next useful action. Link specs, issues, commits, and key files instead of restating them. Never include credentials or sensitive personal data.

Read any supplied prior handoff and carry forward still-relevant unresolved facts. Correct stale claims using the current tree and current feedback. Loop's post-stage commit record and Git state take precedence over older notes. Produce a concise replacement of the useful accumulated context, not a log of everything attempted. Distinguish verified facts from hypotheses; do not claim unrun checks passed.

## Delivery

- During a Loop implementation or fix stage, put issue-specific notes in the final `## Loop handoff` block. Loop persists that block to `.loop/handoffs/<project>/<id>.md`, preserving its own pending review feedback. Do not write a parallel debrief or edit the state file directly.
- Cross-issue facts belong in the shared project notes at the absolute path the runner supplies (normally `.loop/notes/<project>.md`). Update these only when the prompt permits it. Read first, correct or remove stale entries, and avoid duplicates and issue-specific narration.
- A planning session explicitly asked to seed Loop notes may use `.loop/notes/<project>.md` in the main checkout. Keep durable requirements and decisions in the spec and repository documentation; runtime notes are supplementary and gitignored.
- Supplied absolute paths may point into the main checkout from a worktree. Use them as supplied. Do not invent `.loop/state/` paths or save context in an OS temporary directory that later stages cannot find.

Keep scope, unresolved blockers, and next actions clear. Do not add a suggested-skills list: the runner chooses its own workflow.
