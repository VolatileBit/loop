---
name: loop-code-review
description: Review supplied changes against repository standards and a supplied issue or spec in an unattended Loop session. Use when the runner requests a review; report through its verdict protocol.
---

## How to review

Use the baseline, issue, spec, and previous finding families supplied by Loop. Pin the diff and commit list against that baseline. Read relevant standards, context, and ADRs; linked context can explain a requirement, but do not substitute another spec or search an external tracker for new scope. If a required input is missing, report the gap. When the diff is empty, assess the current tree against the supplied requirements.

This is a review session: do not implement fixes. Follow the runner's stated exceptions for shared project notes. Inspect each suspected problem in context and report only actionable findings with evidence.

## The two axes

Audit both fully and separately. A change can pass one and fail the other, and keeping them apart stops one from masking the other. Run them sequentially in this session — do not delegate them to sub-agents, so the ruling comes from one reviewer that has seen the whole diff.

- **Standards** — does the code conform to this repo's documented coding standards? Look for anything in the repo that documents how code should be written (`CODING_STANDARDS.md`, `CONTRIBUTING.md`, style guides). On top of whatever the repo documents, apply the smell baseline below. Two rules bind it: a documented repo standard always wins (where it endorses something the baseline would flag, suppress the smell), and every smell is a labelled judgement call ("possible Feature Envy"), never a hard violation. Avoid duplicating passing tooling checks. A failing or weakened verification gate still matters. Report a smell only when it has a concrete maintenance or correctness consequence, not to force a preferred design.
- **Spec** — does the code faithfully implement the issue and spec supplied? Report (a) requirements asked for that are missing or partial, (b) behaviour in the diff that wasn't asked for (scope creep), and (c) requirements that look built but where the implementation looks wrong. Quote the issue/spec line for each finding.

### Smell baseline (each reads: what it is → how to fix)

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive standing in for a domain concept that deserves its own type → give the concept its own small type.
- **Repeated Switches** — the same switch/if-cascade on the same type recurs across the change → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files → gather what changes together into one module.
- **Divergent Change** — one module is edited for several unrelated reasons → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward → cut it, call the real target direct.
- **Refused Bequest** — a subclass or builder that ignores most of what it inherits → drop the inheritance, use composition.

## Report

Present findings under `## Standards` and `## Spec` headings. Per finding, cite the standard or spec line and cite the affected file and line. Distinguish hard violations (documented-standard breaches) from judgement calls (baseline smells). Check each suspected problem against the actual code before reporting it. Keep the two axes distinct; group findings sharing one violated invariant into the stable finding families required by Loop. End with a one-line summary: total findings per axis and the worst issue within each axis.

## Runner output

The supplied prompt defines the output protocol. For Loop, finish with `## Loop verdict` (`changes-requested: yes|no`, `severity: blocking|nits-only|none`, and `summary:`), followed by `## Loop finding families`. A pass or nits-only verdict uses `- none` for families. List optional improvements individually under `## Loop nits` when required. Do not replace these blocks with a JSON ruling file or invent a squash-commit field.

For blocking findings, state the violated invariant, inspect relevant sibling branches and error cases, and group the examples under one stable family ID. Reuse IDs from prior review history and recheck the full invariant. A style preference alone is not blocking; a spec gap, incorrect behavior, security defect, or inadequate verification gate can be.

Loop's issue checkboxes and lifecycle frontmatter are expected bookkeeping. Do not flag them as scope creep. Assess the entire change since the baseline, not just the last fix commit.
