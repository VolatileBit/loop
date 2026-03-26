/**
 * Bundled test-driven-development workflow, embedded into implement/fix
 * prompts when `tddSkill` is set to `"builtin"`. Adapted from the Claude Code
 * `/tdd` skill (SKILL.md + tests.md + mocking.md) so loop is self-contained:
 * no per-machine or per-repo skill installs, and every agent CLI —
 * claude-code, codex, cursor, copilot — receives the identical, full
 * workflow. Interactive steps ("confirm seams with the user") are adapted for
 * unattended runs.
 */
export const BUILTIN_TDD_SKILL = `## How to work: test-driven development

TDD is the red → green loop. Every rule below applies on every cycle — consult
them before and during the loop, not after.

When exploring the codebase, read CONTEXT.md (if it exists) so test names and
interface vocabulary match the project's domain language, and respect ADRs in
the area you're touching.

### What a good test is

Tests verify behavior through public interfaces, not implementation details.
Code can change entirely; tests shouldn't. A good test reads like a
specification — "user can checkout with valid cart" tells you exactly what
capability exists — and survives refactors because it doesn't care about
internal structure. Characteristics: tests behavior callers care about, uses
the public API only, describes WHAT not HOW, one logical assertion per test.

Verify through the interface, not around it:

- BAD: call createUser, then query the database directly to check the row.
- GOOD: call createUser, then retrieve the user through getUser and assert on it.

### Seams — where tests go

A seam is the public boundary you test at: the interface where you observe
behavior without reaching inside. Tests live at seams, never against
internals. You are running unattended, so instead of confirming seams with a
human: derive them from the issue's acceptance criteria and the module's
existing public surface, state your chosen seams in your closing \`## Loop
handoff\` block, and test only at those. You can't test everything — choosing
seams up front is how testing effort lands on critical paths and complex logic
instead of every edge case.

### Anti-patterns

- **Implementation-coupled** — mocks internal collaborators, tests private
  methods, or verifies through a side channel (querying the database instead
  of using the interface). The tell: the test breaks when you refactor but
  behavior hasn't changed. Also: asserting on call counts/order, test names
  that describe HOW instead of WHAT.
- **Tautological** — the assertion recomputes the expected value the way the
  code does (expect(add(a, b)).toBe(a + b), a snapshot derived by hand the
  same way, a constant asserted equal to itself), so it passes by construction
  and can never disagree with the code. Expected values must come from an
  independent source of truth — a known-good literal, a worked example, the
  spec.
- **Horizontal slicing** — writing all tests first, then all implementation.
  Bulk tests verify imagined behavior: you test the shape of things rather
  than user-facing behavior, the tests go insensitive to real changes, and you
  commit to test structure before understanding the implementation. Work in
  vertical slices instead — one test → one implementation → repeat, each test
  a tracer bullet that responds to what the last cycle taught you.

### Mocking

Mock at system boundaries only: external APIs (payment, email), time and
randomness, sometimes databases (prefer a test DB) and the file system. Do not
mock your own classes/modules, internal collaborators, or anything you
control. At boundaries, design for mockability: inject dependencies rather
than constructing them internally, and prefer SDK-style interfaces (one
function per external operation, each independently mockable) over one generic
fetcher that forces conditional logic into every mock.

### Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to
  pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per
  cycle.
- **Refactoring is not part of the loop.** It belongs to review, not the
  red → green implementation cycle.
- **Exceptions (no test-first required):** documentation-only changes,
  configuration files, and trivial content files with no behavior — don't
  manufacture tests for content that cannot meaningfully fail.`;
