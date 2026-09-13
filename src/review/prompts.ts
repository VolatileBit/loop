/**
 * Implement / review prompt builders. Skill directives are config-driven
 * (`reviewSkill`/`tddSkill`) — when unset, the directive lines are omitted
 * and the review prompt asks the agent to review against the issue spec and
 * repo conventions directly. An optional `specRelPath` adds the spec
 * context line resolved by issues/resolve-spec.ts.
 */

import path from 'node:path';

import { DEFAULT_TRIAGE_LABELS } from '../config/triage-labels.js';
import { buildLoopCommitMessage, resolveImplementCommitLabel, LOOP_COMMIT_HEADING } from '../git/commit.js';
import { formatReviewFixedPoint } from '../git/fixed-point.js';
import { LOOP_HANDOFF_HEADING } from '../handoff/handoff.js';
import { readRuntimeSkill } from '../skills/bundled.js';
import { buildBuiltinReviewSkill } from '../skills/code-review.js';
import { BUILTIN_TDD_SKILL } from '../skills/tdd.js';
import {
  formatReviewConvergenceHistory,
  LOOP_FINDING_FAMILIES_HEADING,
  LOOP_FIX_COVERAGE_HEADING,
  summarizeReviewConvergence,
  type ReviewConvergenceHistory,
} from './convergence.js';

/**
 * `reviewSkill`/`tddSkill` value that embeds loop's bundled workflow text into
 * the prompt instead of referencing an installed slash-command — every agent
 * CLI then receives the identical, full workflow with nothing installed on
 * the machine or repo.
 */
export const BUILTIN_SKILL = 'builtin';

export const LOOP_VERDICT_HEADING = '## Loop verdict';
export const LOOP_NITS_HEADING = '## Loop nits';

const HANDOFF_SKILL = readRuntimeSkill('loop-handoff');

/** The slice of an issue both prompt builders need. */
export type PromptIssue = {
  qualifiedId: string;
  title: string;
  relPath: string;
};

/** Config-driven prompt context shared by both builders. */
export type PromptContext = {
  /** Skill directive for review prompts (e.g. "/review-work"). Null/unset = omit. */
  reviewSkill?: string | null;
  /** Skill directive for implement prompts (e.g. "/tdd"). Null/unset = omit. */
  tddSkill?: string | null;
  /** Repo-relative spec doc path (issues/resolve-spec.ts). Null/unset = omit the context line. */
  specRelPath?: string | null;
  /** Label strings surfaced in prompt instructions (defaults to loop's generic set). */
  labels?: { inProgress: string; done: string };
  /**
   * The external verify command loop gates this work with. When set, implement
   * and fix prompts state the in-session-proof deal: run it exactly as written,
   * bare, as the last shell command before committing, and loop skips its own
   * duplicate run (see agent/evidence.ts). Null/unset = omit.
   */
  verifyCmd?: string | null;
  /**
   * Absolute path to the shared per-project notes file (see
   * handoff/project-notes.ts). Every stage reads it; implement and review
   * sessions update it. Null/unset = omit.
   */
  projectNotesPath?: string | null;
  /**
   * Project mode with `allowDeclaredVerify`: the session may replace the
   * configured command for this issue by writing `declarePath`. Absent = the
   * configured command is the only gate.
   */
  declaredVerify?: {
    /** Absolute path the session writes its replacement to (outside the worktree). */
    declarePath: string;
    /** The command configured for this project — what a replacement is judged against. */
    configuredCmd: string;
    /** The replacement already in effect, when a session has declared one. */
    declaredCmd: string | null;
  };
  /**
   * Goal mode: the verify contract inverts — there is no configured command;
   * the implement session chooses and declares one. All paths absolute (the
   * goal folder lives outside the worktree).
   */
  goal?: {
    goalDocPath: string;
    declareVerifyPath: string;
    verifyNotesPath: string;
  };
};

function promptLabels(context?: PromptContext): { inProgress: string; done: string } {
  return context?.labels ?? {
    inProgress: DEFAULT_TRIAGE_LABELS.inProgress,
    done: DEFAULT_TRIAGE_LABELS.done,
  };
}

function featureContextLine(specRelPath: string | null | undefined, verb: string): string | null {
  if (!specRelPath) return null;
  // An absolute path means the doc is untracked and therefore lives only in the
  // main checkout — say so, or a session in a worktree reads it as a repo path
  // and re-anchors its sense of the project root there.
  const note = path.isAbsolute(specRelPath)
    ? ' It sits outside this working tree — read it at that absolute path, and make no edits there.'
    : '';
  return `- Feature context: read \`${specRelPath}\` for the parent spec before ${verb}.${note}`;
}

/**
 * Project-mode block for implement/fix prompts. Deliberately framed as the
 * *exception*: the configured gate is a human's decision, and most issues have
 * no business touching it. What justifies the escape hatch is that a gate
 * frozen at setup time silently stops covering code written months later —
 * a gate that misses an edited package doesn't fail loudly, it passes a real
 * break silently.
 */
function declaredVerifyLines(declared: NonNullable<PromptContext['declaredVerify']>): string[] {
  return [
    '**Replacing the verify command — the exception, not the routine.**',
    `- This project's configured gate is \`${declared.configuredCmd}\`. Use it. Replace it only when it genuinely fails to cover the work this issue touches — a package it never runs, a service this issue adds.`,
    ...(declared.declaredCmd
      ? [`- A previous session already replaced it for this issue with \`${declared.declaredCmd}\`. Correct that if it is wrong; otherwise leave it alone.`]
      : []),
    `- To replace it, write the command — one line, exactly as it should be run, bare (no \`cd\`, no pipes) — to \`${declared.declarePath}\` with your file tools. Loop re-reads it before every run, so a later fix session can correct a wrong choice.`,
    '- A replacement must be **at least as strong** as the configured command over what this issue changed. Narrowing the gate to dodge a failure is a blocking review finding, and the review sees both commands side by side.',
    '- The configured command still runs after the merge regardless, so a narrowed gate cannot shrink what the merged tree is held to.',
    '- That file is loop\'s own bookkeeping, not part of the work: writing it is never "out of scope", however tightly this issue words its scope.',
    '',
  ];
}

/** Goal-mode block for implement/fix prompts: the declared-verify contract. */
function goalImplementLines(goal: NonNullable<PromptContext['goal']>): string[] {
  return [
    '## Goal mode',
    '',
    `The goal is the spec for this issue: read it at \`${goal.goalDocPath}\` (absolute path) before implementing.`,
    '',
    '**Verify contract — you choose the gate.** There is no configured verify command for goal work:',
    `- Decide the command that best proves this issue's work (specific enough to fail if the work is wrong, cheap enough to run repeatedly), and write it — one line, exactly as it should be run, bare (no \`cd\`, no pipes) — to \`${goal.declareVerifyPath}\` with your file tools.`,
    `- Append a short note to \`${goal.verifyNotesPath}\`: what the command verifies and why you chose it.`,
    '- Loop executes **exactly** what you declared, as this issue\'s gate and again after merges. No declaration means the issue escalates to a human as unverifiable.',
    '- You may correct a wrong declaration in a later fix session (the file is re-read before every run) — but weakening it to dodge a failure is a blocking review finding.',
    '- The in-session-proof deal applies to your declared command: run it exactly as declared, bare, as the last shell command before `git add`/`git commit`, and loop skips its duplicate run.',
    '',
    '---',
    '',
  ];
}

export type ReviewPromptOptions = {
  round?: number;
  /** Raw fixed point (SHA or ref) — formatted internally via formatReviewFixedPoint. */
  fixedPoint: string;
  /** Compact, structured history from prior review/fix sessions for this issue. */
  history?: ReviewConvergenceHistory;
};

export function buildReviewPrompt(
  issue: PromptIssue,
  options: ReviewPromptOptions,
  context: PromptContext = {},
): string {
  const roundNote = options.round && options.round > 1 ? ` (review round ${options.round})` : '';
  const fixedPoint = formatReviewFixedPoint(options.fixedPoint, issue.qualifiedId);
  const reviewSkill = context.reviewSkill ?? null;
  const builtinSkill = reviewSkill === BUILTIN_SKILL;
  const specLine = featureContextLine(context.specRelPath, 'reviewing');
  const historyBlock = options.history
    ? formatReviewConvergenceHistory(options.history)
    : '';

  const opening =
    reviewSkill && !builtinSkill
      ? `Run ${reviewSkill}${roundNote} for ${issue.relPath} (${issue.qualifiedId}: ${issue.title}).`
      : `Review the work${roundNote} for ${issue.relPath} (${issue.qualifiedId}: ${issue.title}) against the issue spec and this repository's conventions.`;

  const verdictLeadIn = builtinSkill
    ? 'Follow the two-axis workflow above (Standards + Spec). After ## Standards and ## Spec, produce the structured blocks below exactly:'
    : reviewSkill
      ? `Follow the ${reviewSkill} skill (Standards + Spec axes). After ## Standards and ## Spec, produce the structured blocks below exactly:`
      : 'Assess the work along two axes — Standards (repo conventions) and Spec (the issue requirements) — then produce the structured blocks below exactly:';

  return [
    opening,
    '',
    'This is a **review-only** session in a fresh context window. Do not implement code changes.',
    '',
    `Spec source: ${issue.relPath}`,
    ...(specLine ? [specLine] : []),
    ...(context.goal
      ? [
          `- Goal context: this work serves the goal at \`${context.goal.goalDocPath}\` (absolute path — read it).`,
          `- Also judge the **declared verify command** in \`${context.goal.declareVerifyPath}\` against the diff: is it adequate proof of this work? An inadequate or weakened gate is a blocking finding.`,
        ]
      : []),
    // Both commands, side by side: judging a replacement needs the thing it
    // replaced, or "adequate" has nothing to be adequate against.
    ...(context.declaredVerify?.declaredCmd
      ? [
          `- This issue's session **replaced the verify command**. Configured: \`${context.declaredVerify.configuredCmd}\`. Declared: \`${context.declaredVerify.declaredCmd}\`.`,
          '- Judge the replacement against the diff. It is a **blocking** finding when the declared command is merely easier to pass — narrower coverage of what this issue changed, a subset of tests, a skipped typecheck. It is fine when it genuinely covers work the configured command does not reach.',
        ]
      : []),
    `Fixed point: ${fixedPoint}`,
    '',
    ...(historyBlock ? [historyBlock, ''] : []),
    'Convergence rules:',
    '- For each blocking symptom, state the violated invariant and inspect all relevant sibling branches, modes, types, and error paths before reporting it.',
    '- Group concrete findings that share a root cause under one stable lower-kebab-case family id. Do not drip-feed one example from the same family in each review round.',
    '- If prior history contains the same invariant, reuse its exact family id and re-test the full invariant even when the last concrete example was fixed.',
    '- A family is resolved only when the implementation and tests cover its relevant behavior matrix; a patch for only the reported example is not enough.',
    '',
    'Read the root `CONTEXT.md` (map/index) and any package-level `CONTEXT.md` for the areas under review — useful background, do not edit them (this session is read-only).',
    ...(context.projectNotesPath
      ? [
          `Shared project notes: \`${context.projectNotesPath}\` (absolute path — may live outside the review tree) hold cross-issue facts from earlier sessions; read them for context. As the **one exception** to read-only, you may correct stale entries or add durable cross-issue facts you verified during review — never verdict rationale or per-issue narrative.`,
        ]
      : []),
    ...(builtinSkill ? ['', buildBuiltinReviewSkill(options.fixedPoint), ''] : ['']),
    verdictLeadIn,
    '',
    LOOP_VERDICT_HEADING,
    'changes-requested: yes|no',
    'severity: blocking|nits-only|none',
    'summary: one line explaining the verdict',
    '',
    'For every blocking verdict, follow it with one bullet per root-cause family. Use `- none` for a pass or nits-only verdict:',
    '',
    LOOP_FINDING_FAMILIES_HEADING,
    '- `<stable-family-id>`: the invariant that every concrete finding in this family violates',
    '',
    'Verdict rules:',
    '- `changes-requested: yes` + `severity: blocking` — spec gaps, security issues, missing acceptance criteria, or incorrect behaviour.',
    '- `changes-requested: yes` + `severity: nits-only` — minor style or optional improvements only; no fix required before shipping.',
    '- `changes-requested: no` + `severity: none` — ready to ship.',
    '',
    'If severity is `nits-only`, also list every nit as its own bullet in this block so loop can track them for later cleanup:',
    '',
    LOOP_NITS_HEADING,
    '- one nit per line, each independently actionable',
    '',
    'If the git diff since the fixed point is empty, review the current tree against the issue — an empty diff is normal when the work was already implemented before this loop run.',
    '',
    "Loop's own workflow edits the issue file (checking acceptance boxes, `triage:`/`lastStage:` frontmatter) — those bookkeeping edits are required, never a finding, and never \"out of scope\" regardless of how the issue words its scope.",
    '',
    'Headless mode: do not use AskQuestion or wait for user input; infer context from the issue file and git state.',
  ].join('\n');
}

export type FixNitsPromptOptions = {
  /** Absolute path to the nits backlog file (it lives outside the work root). */
  nitsPath: string;
  verifyCmd: string;
};

export const LOOP_NITS_DECISIONS_HEADING = '## Loop nits decisions';

/**
 * One session over the whole nits backlog: fix or dismiss every section,
 * editing the backlog file itself, then verify and commit. Decisions come back
 * as a result block (parsed by review/nits.ts `parseNitsDecisions`) — a
 * malformed report fails the batch, which restores the backlog snapshot.
 */
export function buildFixNitsPrompt(options: FixNitsPromptOptions): string {
  return [
    `Work through every entry in the nits backlog at \`${options.nitsPath}\` (use your file tools on this absolute path directly — it may live outside your working tree).`,
    '',
    'Each `## <project/id — title>` section lists non-blocking review findings loop accumulated for that issue. For every section, in file order:',
    '- Decide per finding: **fix** it (small, safe, in the spirit of the original issue) or **dismiss** it (only with a concrete reason — intentional design, obsolete, not worth the churn).',
    '- Apply fixes in this working tree.',
    '- Edit the backlog file itself: delete each section you have finished with (fixed or dismissed) so the file only ever contains unaddressed findings.',
    '',
    'Do not start new features or refactors beyond what a finding asks for.',
    '',
    `When every section is handled, confirm the tree still passes verification: run \`${options.verifyCmd}\` **exactly as written** — bare, no \`cd\` prefix, no pipes or output trimming — as the last shell command before \`git add\`/\`git commit\`; loop then skips its duplicate verify run.`,
    '',
    'Commit your changes (code + any docs) with message convention `review: address nits backlog (nits)`.',
    '',
    'Headless mode: this is a non-interactive agent session. Do not prompt for confirmations.',
    '',
    'End your final response with exactly this block, one bullet per issue section you handled:',
    '',
    LOOP_NITS_DECISIONS_HEADING,
    '- <project/id>: fixed — one-line summary of what changed',
    '- <project/id>: dismissed — the concrete reason',
  ].join('\n');
}

export type DistillPromptOptions = {
  project: string;
  /** Absolute path to the shared project notes file. */
  notesPath: string;
  /** Absolute dir holding the project's run artifacts (archived handoffs live one level below it). */
  runArchiveDir: string;
  verifyCmd: string;
};

/**
 * The polish distill session: promote the project's accumulated agent notes
 * into the repo's tracked CONTEXT.md files, then shrink the notes back down —
 * notes are working memory, CONTEXT.md is the record.
 */
export function buildDistillPrompt(options: DistillPromptOptions): string {
  return [
    `Distill the accumulated agent knowledge for project "${options.project}" into this repository's tracked context docs.`,
    '',
    'Sources (absolute paths — they may live outside your working tree; read them with your file tools):',
    `- Shared project notes: \`${options.notesPath}\` — the primary source.`,
    `- Archived per-issue handoffs: \`${options.runArchiveDir}/*/handoff.md\` — optional color on how the issues actually went.`,
    '',
    'Do:',
    '- Promote only durable, still-true, cross-issue knowledge into the appropriate `CONTEXT.md` — package-level files for package-specific facts, the root file for domain vocabulary or one-line pointers. **Verify each claim against the code before promoting it**; drop anything stale, one-off, or already covered.',
    '- Keep `CONTEXT.md` concise and durable: intent, invariants, constraints, conventions. Never implementation narration, history, or per-issue detail.',
    '- Then rewrite the notes file itself down to whatever remains genuinely useful but unpromoted (often nothing) — promoted knowledge must not live in both places.',
    '',
    `Your edits must pass verification. ${verifyProofDealLine(options.verifyCmd)}`,
    '',
    `Commit when done — suggested message: \`doc: distill ${options.project} notes into CONTEXT.md (${options.project})\`. Loop commits automatically if the tree is still dirty afterwards.`,
    '',
    'Headless mode: this is a non-interactive agent session. Do not prompt for confirmations.',
  ].join('\n');
}

export type ImplementPromptOptions = {
  reviewFeedback?: {
    body: string;
    round: number;
    /** Review/fix ledger including the verdict that triggered this pass. */
    history?: ReviewConvergenceHistory;
  };
  verifyFeedback?: { cmd: string; output: string; round: number; failures: string[] };
  commitLabel?: string;
  /** Handoff note left by the previous stage in this issue's pipeline, if any. */
  handoff?: string | null;
};

const VERIFY_OUTPUT_PROMPT_MAX_CHARS = 12_000;

function truncateVerifyOutputForPrompt(output: string, maxChars = VERIFY_OUTPUT_PROMPT_MAX_CHARS): string {
  if (output.length <= maxChars) return output.trim();
  return `…(truncated — see verify log on disk)\n\n${output.slice(-maxChars).trim()}`;
}

/**
 * The in-session-proof deal (see agent/evidence.ts): a bare, unaltered run of
 * the exact verify command as the session's last shell command is trusted by
 * loop, which then skips its own duplicate run. Pipes mask exit codes, so
 * piped/altered invocations are never trusted.
 */
function verifyProofDealLine(verifyCmd: string): string {
  return (
    `To have that run count, run \`${verifyCmd}\` **exactly as written** — bare, no \`cd\` prefix, no pipes ` +
    'or output trimming, no extra flags — as the last shell command before `git add`/`git commit`, after ' +
    'every file edit (code, docs, issue checkboxes). Loop then skips its duplicate verify run; piped or ' +
    'altered invocations cannot be trusted (a pipe masks the exit code) and are re-run.'
  );
}

export function buildImplementPrompt(
  issue: PromptIssue,
  options: ImplementPromptOptions = {},
  context: PromptContext = {},
): string {
  const { reviewFeedback, verifyFeedback, commitLabel, handoff } = options;
  const labels = promptLabels(context);
  const reviewSkill = context.reviewSkill === BUILTIN_SKILL ? null : (context.reviewSkill ?? null);
  const tddSkill = context.tddSkill ?? null;
  const specLine = featureContextLine(context.specRelPath, 'implementing');

  const implementCommitLabel = resolveImplementCommitLabel({
    commitLabel,
    verifyFeedback,
    reviewFeedback,
  });
  const commitMessage = buildLoopCommitMessage(issue.qualifiedId, implementCommitLabel);
  const handoffIsHistorical = reviewFeedback !== undefined || verifyFeedback !== undefined;

  const handoffBlock = handoff?.trim()
    ? [
        handoffIsHistorical
          ? '## Historical handoff from the previous stage'
          : '## Handoff from previous stage',
        '',
        ...(handoffIsHistorical
          ? [
              'Current review feedback and the Git working tree are authoritative. This handoff is historical context only and may describe worktree state from before Loop created its fallback commit.',
            ]
          : [
              'A previous loop stage on this issue left the following notes for you. Use them to skip redundant exploration.',
            ]),
        '',
        handoff.trim(),
        '',
        '---',
        '',
      ].join('\n')
    : '';

  const reviewHistoryBlock = reviewFeedback?.history
    ? formatReviewConvergenceHistory(reviewFeedback.history)
    : '';
  const reviewConvergence = reviewFeedback?.history
    ? summarizeReviewConvergence(reviewFeedback.history)
    : null;
  const recurringFamilies = reviewConvergence?.recurringFamilies ?? [];
  const deepFixBlock =
    recurringFamilies.length > 0
      ? [
          '## Deep-fix mode',
          '',
          'A root-cause family has survived an earlier fix. Stop patching the latest example and determine why the prior approach was incomplete:',
          ...recurringFamilies.map(
            (family) =>
              `- \`${family.id}\` has recurred across ${family.occurrences} reviews — ${family.invariant}`,
          ),
          '',
          'Build an explicit behavior matrix for each recurring family, audit the shared enforcement seam and every supported dimension, and add tests that would have failed for both the earlier and current examples. The exact examples are not the boundary of the fix.',
          '',
        ].join('\n')
      : '';

  const reviewBlock = reviewFeedback
    ? [
        `## Review feedback (fix round ${reviewFeedback.round})`,
        '',
        'A separate review session found **blocking** issues. Address every blocking root cause below, then re-run tests.',
        '',
        'Fix protocol:',
        '- Before editing, state the invariant each finding family violates.',
        '- Locate the narrowest shared seam that can enforce the invariant instead of patching each symptom locally.',
        '- Enumerate sibling paths, supported modes/types, inverse cases, and independent error branches that could violate the same invariant.',
        '- Add regression coverage for the reported example plus representative adjacent and cross-dimension cases.',
        '- Re-run tests associated with every prior occurrence of the family. A fix is incomplete when it only handles the exact examples in the latest review.',
        ...(context.verifyCmd
          ? ['', `Confirm the fix passes verification. ${verifyProofDealLine(context.verifyCmd)}`]
          : []),
        '',
        ...(reviewHistoryBlock ? [reviewHistoryBlock, ''] : []),
        ...(deepFixBlock ? [deepFixBlock] : []),
        '## Current blocking review',
        '',
        reviewFeedback.body.trim(),
        '',
        '---',
        '',
      ].join('\n')
    : '';

  const verifyBlock = verifyFeedback
    ? [
        `## Verification failure (fix round ${verifyFeedback.round})`,
        '',
        `Loop ran external verification (\`${verifyFeedback.cmd}\`) and it **failed**. Fix every type error and failing test, then ensure the full verify command passes.`,
        '',
        `Confirm the fix by re-running the command yourself. ${verifyProofDealLine(verifyFeedback.cmd)}`,
        '',
        ...(verifyFeedback.failures.length > 0
          ? ['### Failure summary', '', ...verifyFeedback.failures.map((line) => `- ${line}`), '']
          : []),
        '### Verify output',
        '',
        truncateVerifyOutputForPrompt(verifyFeedback.output),
        '',
        '---',
        '',
      ].join('\n')
    : '';

  const feedbackBlock = [reviewBlock, verifyBlock, handoffBlock].filter(Boolean).join('');

  const noReviewLine = reviewSkill
    ? `Do not run ${reviewSkill} in this session — loop runs review in a separate session after verify.`
    : 'Do not run a review pass in this session — loop runs review in a separate session after verify.';

  return [
    feedbackBlock,
    ...(context.goal ? goalImplementLines(context.goal) : []),
    ...(context.declaredVerify ? declaredVerifyLines(context.declaredVerify) : []),
    `Implement the work described in ${issue.relPath} (${issue.qualifiedId}: ${issue.title}).`,
    '',
    'Implement the work described by the user in the spec or issues.',
    '',
    ...(tddSkill === BUILTIN_SKILL
      ? [BUILTIN_TDD_SKILL, '']
      : tddSkill
        ? [`Use ${tddSkill} where possible, at pre-agreed seams.`, '']
        : []),
    'Run typechecking regularly, single test files regularly, and the full test suite once at the end.',
    ...(context.verifyCmd ? ['', verifyProofDealLine(context.verifyCmd)] : []),
    '',
    noReviewLine,
    '',
    'Headless mode: this is a non-interactive agent session. Do not prompt for confirmations.',
    'Project:',
    `- Work on this issue only: ${issue.relPath}`,
    ...(specLine ? [specLine] : []),
    '- Read the root `CONTEXT.md` (a map/index of domain vocab and pointers to package-level context) and any `CONTEXT.md` in the packages/apps you are about to touch — this exists to save you re-deriving known architecture.',
    ...(context.projectNotesPath
      ? [
          `- Also read the shared project notes at \`${context.projectNotesPath}\` (absolute path — may live outside your working tree): durable cross-issue facts earlier sessions left for this project (system/testing quirks, verify noise, where conventions live). Treat them as a starting point, not gospel — verify anything that looks stale.`,
        ]
      : []),
    '- Do not start other issues or unrelated files.',
    '',
    'Git (only when you change files):',
    '- If the work is **already implemented** and every acceptance criterion is satisfied, verify and finish — **no commit required**.',
    '- Do **not** add filler edits, noop tests, or empty commits (`git commit --allow-empty`) just to satisfy loop.',
    '- If you **did** change files, commit before finishing (code, tests, docs, issue checkboxes).',
    '- Commit message convention: `<type>: <summary> (<issue-id>)`, type is one of `feat`/`fix`/`doc`/`chore`/`review` matching the nature of the change.',
    `- Suggested message when committing: \`git commit -m "${commitMessage}"\``,
    '- Loop commits automatically if the working tree is still dirty after this session, using the same convention.',
    '',
    'Shared context (update before finishing):',
    '- If you learned durable architecture/domain knowledge worth keeping (not implementation narration), add a concise note to the relevant `CONTEXT.md` — package-level for package-specific knowledge, root for domain vocab or a one-line pointer to a new package-level file.',
    ...(context.projectNotesPath && !reviewFeedback && !verifyFeedback
      ? [
          `- Update the shared project notes at \`${context.projectNotesPath}\`: only knowledge that saves a future session working on a **different** issue in this project — module/convention locations, verify commands and their known-harmless noise, testing quirks. Correct or remove stale entries rather than appending duplicates; issue-specific detail belongs in the handoff block below instead.`,
        ]
      : []),
    '',
    HANDOFF_SKILL,
    '',
    'When complete:',
    '- Check off acceptance criteria (`- [x]`) only when verified; leave incomplete or blocked criteria unchecked and explain what remains.',
    `- Leave frontmatter \`triage: ${labels.inProgress}\` — loop sets \`${labels.done}\` only after external verify and review pass.`,
    `- Do not set \`${labels.done}\` yourself; premature \`${labels.done}\` causes misleading run summaries.`,
    '- End your final response with these two blocks so loop can label its fallback commit and hand off context to the next stage:',
    ...(reviewFeedback
      ? [
          '',
          'For a review fix, first report coverage for every current finding family. Loop saves this report for the next fresh review session:',
          '',
          LOOP_FIX_COVERAGE_HEADING,
          '- `<family-id>` — invariant: <what must always hold>; central fix: <shared seam changed>; sibling cases audited: <matrix>; tests: <regressions run or added>',
        ]
      : []),
    '',
    LOOP_COMMIT_HEADING,
    'type: feat|fix|doc|chore|review',
    'summary: one-line description of the change',
    '',
    LOOP_HANDOFF_HEADING,
    'What you did, what remains (if anything), key file locations, and anything the next stage should know. Keep it brief.',
  ]
    .filter(Boolean)
    .join('\n');
}
