/**
 * Goal-mode prompt builders and verdict parsing. Two extra session kinds:
 *
 * - plan: a fresh session in the rolling worktree (so it investigates the
 *   *merged* state) writes the smallest next batch of issue files.
 * - evaluate: a fresh session judges the goal against the observable repo
 *   state — not issue checkboxes — and returns a three-way verdict.
 *
 * All goal-folder paths handed to sessions are absolute (the folder lives in
 * the main repo's `.loop/`, outside the worktree).
 */

export const LOOP_GOAL_VERDICT_HEADING = '## Loop goal verdict';
export const LOOP_GOAL_GAPS_HEADING = '## Loop goal gaps';

export type GoalVerdictStatus = 'reached' | 'not-reached' | 'blocked';

export type GoalVerdict = {
  status: GoalVerdictStatus;
  summary: string;
  /** Concrete gaps when not-reached — fed verbatim into the next plan session. */
  gaps: string[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionBody(text: string, heading: string): string | null {
  const match = text.match(new RegExp(`${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?:\\n## |$)`, 'i'));
  return match ? (match[1] ?? '').trim() : null;
}

/**
 * Parse the evaluator's verdict block. Throws on a missing block, an unknown
 * status, or a not-reached verdict without gaps — a malformed artifact fails
 * the round for a human instead of silently proceeding.
 */
export function parseGoalVerdict(text: string): GoalVerdict {
  const block = sectionBody(text.trim(), LOOP_GOAL_VERDICT_HEADING);
  if (block === null) throw new Error(`evaluation has no "${LOOP_GOAL_VERDICT_HEADING}" block`);

  const status = block.match(/^status:\s*(\S+)/im)?.[1]?.toLowerCase();
  if (status !== 'reached' && status !== 'not-reached' && status !== 'blocked') {
    throw new Error(`goal verdict status must be reached|not-reached|blocked (got "${status ?? 'none'}")`);
  }
  const summary = block.match(/^summary:\s*(.+)$/im)?.[1]?.trim() ?? '';

  const gapsBlock = sectionBody(text.trim(), LOOP_GOAL_GAPS_HEADING);
  const gaps = (gapsBlock ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);

  if (status === 'not-reached' && gaps.length === 0) {
    throw new Error('a not-reached goal verdict must list concrete gaps under "## Loop goal gaps"');
  }

  return { status, summary, gaps };
}

export type PlanPromptOptions = {
  slug: string;
  goalDocPath: string;
  /** Absolute project folder the plan session writes issue files into. */
  issuesProjectDir: string;
  /** Absolute path to PLAN.md — the plan session keeps it current. */
  planDocPath: string;
  verifyNotesPath: string;
  maxIssues: number;
  /** The runnable-fresh triage label new issues must carry. */
  readyLabel: string;
  /** Gaps from the previous round's evaluation, verbatim. */
  gaps: string[];
  /** Max replacements per lineage before the goal blocks. */
  supersedeLimit: number;
  /** Ids escalated to a human so far (candidates for a supersede within the lineage budget). */
  escalatedIds: string[];
  /** Ids that may NOT be superseded again (their lineage already burned its retry). */
  exhaustedLineageIds: string[];
};

export function buildPlanPrompt(options: PlanPromptOptions): string {
  return [
    `Plan the next batch of work toward a goal. Read the goal at \`${options.goalDocPath}\` — it is the spec for this work.`,
    '',
    'This session runs in the repository the goal targets, at its current (merged) state. Investigate the code as it is now — do not assume earlier plans described the present.',
    '',
    `Existing backlog and shared knowledge (absolute paths — use your file tools on them directly):`,
    `- Issue files: \`${options.issuesProjectDir}/\` (read them all; do not duplicate work that is planned, in progress, or done)`,
    `- Verify knowledge: \`${options.verifyNotesPath}\``,
    ...(options.gaps.length > 0
      ? ['', 'The previous evaluation found the goal **not reached**, with these concrete gaps to address:', ...options.gaps.map((gap) => `- ${gap}`)]
      : []),
    '',
    `Write the **smallest** batch of new issue files (at most ${options.maxIssues}; fewer is better; zero if the backlog already covers the remaining work) into \`${options.issuesProjectDir}/\`, continuing the existing \`NN-slug.md\` numbering. Each file:`,
    '',
    '```markdown',
    '---',
    'id: NN-short-slug',
    'title: One-line title',
    `triage: ${options.readyLabel}`,
    '---',
    '',
    'What to do and why it moves the goal forward.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] Concrete, checkable criterion',
    '',
    '## Blocked by',
    '',
    '- NN-other-issue   (only when a real dependency exists; omit the section otherwise)',
    '```',
    '',
    'Rules:',
    '- Small, independently verifiable issues on the critical path to the goal. No speculative breadth.',
    '- `id` must match the filename (without `.md`) and be unique in the folder.',
    '- **Dependencies drive parallelism**: loop runs unblocked issues concurrently in isolated worktrees. Add a `## Blocked by` edge only for real ordering constraints (issue B edits what A creates); leave genuinely independent issues unlinked so they can run in parallel, and prefer slicing work so files rarely overlap between parallel issues.',
    `- Keep the plan document at \`${options.planDocPath}\` current: the batch's structure, what depends on what and why, in a few lines (create it if missing).`,
    ...(options.escalatedIds.length > 0
      ? [
          `- Escalated issues needing a human: ${options.escalatedIds.join(', ')}. You may **supersede** such an issue with a genuinely different approach (at most ${options.supersedeLimit} replacements per original issue, across all rounds): edit the old file's triage to \`wontfix\`, and give the replacement a \`Supersedes: <old-id>\` line directly under the frontmatter.`,
          ...(options.exhaustedLineageIds.length > 0
            ? [`- These ids' lineages already burned their full supersede budget and must NOT be superseded again: ${options.exhaustedLineageIds.join(', ')}.`]
            : []),
        ]
      : []),
    '- Do not modify repository code in this session — only files under the goal folder.',
    '',
    'Headless mode: do not prompt for confirmations. End your final response with a one-line-per-issue summary of what you created (or "no new issues" and why).',
  ].join('\n');
}

export type EvaluatePromptOptions = {
  slug: string;
  goalDocPath: string;
  issuesProjectDir: string;
  verifyNotesPath: string;
  round: number;
  /** Outcome lines of the mechanical re-runs of every declared verify command. */
  mechanicalResults: string[];
};

export function buildEvaluatePrompt(options: EvaluatePromptOptions): string {
  return [
    `Evaluate whether a goal has been reached. Read the goal at \`${options.goalDocPath}\`.`,
    '',
    'This is a **read-only judgement session** in the target repository at its current (merged) state. Judge the goal against the **observable state of the repo** — code, tests, docs as they exist — not against issue checkboxes or reports.',
    '',
    'Context (absolute paths):',
    `- Backlog: \`${options.issuesProjectDir}/\``,
    `- Verify knowledge: \`${options.verifyNotesPath}\``,
    '',
    'Loop already mechanically re-ran every verify command declared so far against this state:',
    ...(options.mechanicalResults.length > 0
      ? options.mechanicalResults.map((line) => `- ${line}`)
      : ['- (none declared yet)']),
    '',
    'Verify claims yourself where cheap (read code, run read-only commands). Then end with **exactly** this block:',
    '',
    LOOP_GOAL_VERDICT_HEADING,
    'status: reached|not-reached|blocked',
    'summary: one line explaining the verdict',
    '',
    'Verdict rules:',
    '- `reached` — the observable repo state satisfies the goal.',
    '- `not-reached` — progress is possible; also list every concrete, actionable gap:',
    '',
    LOOP_GOAL_GAPS_HEADING,
    '- one gap per line, each specific enough to plan an issue from',
    '',
    '- `blocked` — the goal cannot be reached autonomously (ambiguous goal, missing access, contradictory constraints); say why in the summary.',
    '',
    'Headless mode: do not prompt for confirmations.',
  ].join('\n');
}
