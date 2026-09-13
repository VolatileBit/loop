---
name: loop-tdd
description: Implement or fix a supplied issue with behavior tests in an unattended Loop session. Use when the runner requests test-driven development.
---

## How to work: test-driven development

Use this workflow for implementation and fixes in a non-interactive Loop session. Work within the supplied issue and spec.

TDD is the red → green loop. Every rule below applies on every cycle — consult them before and during the loop, not after.

When exploring the codebase, read applicable `CONTEXT.md` files (or the repository's established domain glossary) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

## What a good test is

Tests check behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists — and survives refactors because it doesn't care about internal structure. Characteristics: tests behavior callers care about, uses the public API only, describes WHAT not HOW, one logical assertion per test.

Check through the interface, not around it:

- BAD: call `createUser`, then query the database directly to check the row.
- GOOD: call `createUser`, then retrieve the user through `getUser` and assert on it.

## Seams — where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

You cannot confirm seams with a human, so establish them in this order:

1. **Take the seams already agreed.** If the feature's spec has a `## Testing Decisions` section, follow its agreed boundaries. Treat explicitly proposed or unresolved choices as proposals, not human approval. If a settled boundary cannot prove a requirement, report the conflict rather than silently choosing an easier test.
2. **Otherwise derive them** from the issue's acceptance criteria and the module's existing public surface — prefer an existing seam to a new one, and the highest seam that can observe the behaviour.
3. **Write the seams you chose into the closing `## Loop handoff` block**, with one line on why. This is the record that replaces the human's confirmation, and the next session builds on it rather than re-deciding.

You can't test everything — choosing seams up front is how testing effort lands on critical paths and complex logic instead of every edge case.

## Anti-patterns

- **Implementation-coupled** — mocks internal collaborators, tests private methods, or checks through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed. Also: asserting on call counts/order, test names that describe HOW instead of WHAT.
- **Tautological** — the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth — a known-good literal, a worked example, the spec.
- **Horizontal slicing** — writing all tests first, then all implementation. Bulk tests check imagined behavior: you test the shape of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in vertical slices instead — one test → one implementation → repeat, each test a tracer bullet that responds to what the last cycle taught you.

## Mocking

Mock at system boundaries only: external APIs (payment, email), time and randomness, sometimes databases (prefer a test DB) and the file system. Do not mock your own classes/modules, internal collaborators, or anything you control. At boundaries, design for mockability: inject dependencies rather than constructing them internally, and prefer SDK-style interfaces (one function per external operation, each independently mockable) over one generic fetcher that forces conditional logic into every mock.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactor only on green, within the slice.** Simplify code needed for this change while preserving behavior; rerun the relevant tests. Leave unrelated redesign outside this issue.
- **Exceptions (no test-first required):** documentation-only changes, configuration files, and trivial content files with no behavior — don't manufacture tests for content that cannot meaningfully fail.

## Unattended judgement

Where this skill, the issue, or the spec leaves something genuinely open, make local, reversible decisions from repository evidence and record the assumption in your final summary and handoff. If progress requires a missing credential, human judgment, or an unapproved consequential decision, report the blocker and incomplete criteria; do not guess or claim completion. Never weaken a test, delete a failing one, or narrow a check command to get to green: a failure is information, and disguising it hands the next session a problem it cannot see.
