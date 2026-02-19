/**
 * Triage vocabulary: loop's state machine reasons about fixed semantic
 * *roles*; the label *strings* actually written into issue frontmatter's
 * `triage:` field are configurable per repo via `triageLabels` in
 * loop.config.json. Lifecycle/scheduling code must compare against roles
 * (via a resolved TriageLabels map), never literal strings.
 */

export const TRIAGE_ROLES = [
  'needsTriage',
  'needsInfo',
  'readyForAgent',
  'readyForHuman',
  /**
   * A person has taken this work on — distinct from `readyForHuman`, which
   * means loop tried and got stuck. Non-runnable either way, but loop is no
   * longer waiting on itself for it, so a backlog whose remainder is delegated
   * is complete rather than blocked.
   */
  'delegatedToHuman',
  'wontfix',
  'inProgress',
  'done',
  'verifyFailed',
  'agentFailed',
  'agentInterrupted',
] as const;

export type TriageRole = (typeof TRIAGE_ROLES)[number];

/** Fully-resolved role → label map for one repo. */
export type TriageLabels = Record<TriageRole, string>;

/**
 * Loop's generic out-of-the-box label set. Deliberately concise (`ready` not
 * `ready-for-agent`, `done` not `agent-done`, `needs-human` not
 * `ready-for-human`); repos that need different strings pin them via
 * `triageLabels` in loop.config.json.
 */
export const DEFAULT_TRIAGE_LABELS: TriageLabels = {
  needsTriage: 'needs-triage',
  needsInfo: 'needs-info',
  readyForAgent: 'ready',
  readyForHuman: 'needs-human',
  delegatedToHuman: 'delegated',
  wontfix: 'wontfix',
  inProgress: 'in-progress',
  done: 'done',
  verifyFailed: 'verify-failed',
  agentFailed: 'agent-failed',
  agentInterrupted: 'agent-interrupted',
};

/** Merge a repo's (possibly partial) `triageLabels` config over the defaults. */
export function resolveTriageLabels(config: {
  triageLabels?: Partial<Record<TriageRole, string>> | undefined;
}): TriageLabels {
  const resolved: TriageLabels = { ...DEFAULT_TRIAGE_LABELS };
  for (const role of TRIAGE_ROLES) {
    const label = config.triageLabels?.[role];
    if (typeof label === 'string' && label.trim()) resolved[role] = label.trim();
  }
  return resolved;
}

/** Reverse lookup: which role does a frontmatter label string represent (null if none). */
export function roleForLabel(label: string, labels: TriageLabels): TriageRole | null {
  for (const role of TRIAGE_ROLES) {
    if (labels[role] === label) return role;
  }
  return null;
}
