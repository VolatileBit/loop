/**
 * Bundled two-axis code-review workflow, embedded into review prompts when
 * `reviewSkill` is set to `"builtin"`. Adapted from the Claude Code
 * `/code-review` skill: the parallel sub-agent orchestration is flattened into
 * one sequential review (not every agent CLI can spawn sub-agents), and the
 * spec source is pre-supplied by loop (the issue file and PRD) instead of
 * discovered interactively. The two axes and the full smell baseline are
 * preserved.
 */
export function buildBuiltinReviewSkill(fixedPoint: string): string {
  return `## How to review

Review the diff between ${fixedPoint} and HEAD along two independent axes.
First pin the diff: run \`git diff ${fixedPoint}...HEAD\` and note the commit
list via \`git log ${fixedPoint}..HEAD --oneline\`. Review both axes fully and
separately — a change can pass one axis and fail the other, and keeping them
separate stops one from masking the other:

- **Standards** — does the code conform to this repo's documented coding
  standards? Look for anything in the repo that documents how code should be
  written (e.g. CODING_STANDARDS.md, CONTRIBUTING.md, style guides). On top of
  whatever the repo documents, apply the smell baseline below. Two rules bind
  it: a documented repo standard always wins (where it endorses something the
  baseline would flag, suppress the smell), and every smell is a labelled
  judgement call ("possible Feature Envy"), never a hard violation. Skip
  anything tooling already enforces.
- **Spec** — does the code faithfully implement the issue and PRD supplied
  above? Report (a) requirements asked for that are missing or partial,
  (b) behaviour in the diff that wasn't asked for (scope creep), and
  (c) requirements that look implemented but where the implementation looks
  wrong. Quote the issue/PRD line for each finding.

### Smell baseline (each reads: what it is → how to fix)

- **Mysterious Name** — a function, variable, or type whose name doesn't
  reveal what it does or holds → rename it; if no honest name comes, the
  design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or
  file in the change → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more
  than its own → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together →
  bundle them into one type, pass that.
- **Primitive Obsession** — a primitive standing in for a domain concept that
  deserves its own type → give the concept its own small type.
- **Repeated Switches** — the same switch/if-cascade on the same type recurs
  across the change → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many
  files → gather what changes together into one module.
- **Divergent Change** — one module is edited for several unrelated reasons →
  split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for
  needs the spec doesn't have → delete it; inline back until a real need shows.
- **Message Chains** — long a.b().c().d() navigation the caller shouldn't
  depend on → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward →
  cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores most of what it
  inherits → drop the inheritance, use composition.

### Report format

Present findings under "## Standards" and "## Spec" headings. Per finding,
cite the standard or spec line and quote the offending hunk (file and line).
Distinguish hard violations (documented-standard breaches) from judgement
calls (baseline smells). Verify each suspected problem against the actual code
before reporting it. Do not merge or rerank findings across the two axes.`;
}
