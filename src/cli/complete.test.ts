import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDirs, makeTempRoot, writeIssueFile } from '../issues/test-helpers.js';
import { resolveCompletions } from './complete.js';

afterEach(() => {
  cleanupTempDirs();
});

/** A repo root with two scopes and three issues (default issuesDir "issues"). */
function fixtureRoot(): string {
  const root = makeTempRoot('loop-complete-');
  writeIssueFile(root, 'issues/PRD-001/issue-01.md', {
    frontmatter: { id: 'issue-01', title: 'One', triage: 'ready' },
  });
  writeIssueFile(root, 'issues/PRD-001/issue-02.md', {
    frontmatter: { id: 'issue-02', title: 'Two', triage: 'ready' },
  });
  writeIssueFile(root, 'issues/PRD-006/issue-07.md', {
    frontmatter: { id: 'issue-07', title: 'Seven', triage: 'ready' },
  });
  return root;
}

describe('resolveCompletions: subcommands', () => {
  it('offers all subcommands for an empty first word', () => {
    expect(resolveCompletions([''], '/nonexistent')).toEqual([
      'run',
      'review',
      'fix-nits',
      'polish',
      'archive',
      'goal',
      'goals',
      'init',
      'install',
      'list-runs',
      'completion',
    ]);
  });

  it('filters subcommands by prefix', () => {
    expect(resolveCompletions(['re'], '/nonexistent')).toEqual(['review']);
    expect(resolveCompletions(['li'], '/nonexistent')).toEqual(['list-runs']);
  });
});

describe('resolveCompletions: flags', () => {
  it("offers run's flags for a dash prefix", () => {
    const candidates = resolveCompletions(['run', '--'], '/nonexistent');
    expect(candidates).toContain('--dry-run');
    expect(candidates).toContain('--unblock');
    expect(candidates).toContain('--max-parallel-runs');
    expect(candidates).toContain('--agent-cli');
    expect(candidates).not.toContain('--fix');
    expect(candidates).not.toContain('--ids');
  });

  it("offers review's flags for a dash prefix", () => {
    const candidates = resolveCompletions(['review', '--'], '/nonexistent');
    expect(candidates).toContain('--fix');
    expect(candidates).toContain('--until');
    expect(candidates).toContain('--ids');
    expect(candidates).toContain('--file');
    expect(candidates).not.toContain('--unblock');
  });

  it('narrows flags by prefix', () => {
    expect(resolveCompletions(['run', '--max-p'], '/nonexistent')).toEqual(['--max-parallel-runs']);
  });
});

describe('resolveCompletions: enum flag values', () => {
  it('offers agent CLIs after --agent-cli', () => {
    expect(resolveCompletions(['run', '--agent-cli', ''], '/nonexistent')).toEqual([
      'cursor',
      'claude-code',
      'codex',
      'copilot',
    ]);
    expect(resolveCompletions(['review', '--agent-cli', 'c'], '/nonexistent')).toEqual([
      'cursor',
      'claude-code',
      'codex',
      'copilot',
    ]);
    expect(resolveCompletions(['run', '--agent-cli', 'cl'], '/nonexistent')).toEqual(['claude-code']);
  });

  it('offers shells for the completion subcommand', () => {
    expect(resolveCompletions(['completion', ''], '/nonexistent')).toEqual(['bash', 'zsh']);
    expect(resolveCompletions(['completion', 'z'], '/nonexistent')).toEqual(['zsh']);
  });
});

describe('resolveCompletions: dynamic scopes and issue ids', () => {
  it('offers scopes for the run positional', () => {
    const root = fixtureRoot();
    expect(resolveCompletions(['run', ''], root)).toEqual(['PRD-001', 'PRD-006']);
    expect(resolveCompletions(['run', 'PRD-006'.slice(0, 6)], root)).toEqual(['PRD-001', 'PRD-006']);
  });

  it('does not offer scopes once the positional is taken', () => {
    const root = fixtureRoot();
    expect(resolveCompletions(['run', 'PRD-001', ''], root)).toEqual([]);
  });

  it('offers qualified ids after --until', () => {
    const root = fixtureRoot();
    expect(resolveCompletions(['review', '--until', ''], root)).toEqual([
      'PRD-001/issue-01',
      'PRD-001/issue-02',
      'PRD-006/issue-07',
    ]);
    expect(resolveCompletions(['review', '--until', 'PRD-006'], root)).toEqual(['PRD-006/issue-07']);
  });

  it('completes the segment after the last comma for --ids', () => {
    const root = fixtureRoot();
    expect(resolveCompletions(['review', '--ids', 'PRD-001/issue-01,PRD-006'], root)).toEqual([
      'PRD-001/issue-01,PRD-006/issue-07',
    ]);
  });
});

describe('resolveCompletions: never throws', () => {
  it('returns empty candidates for a broken root', () => {
    expect(resolveCompletions(['run', ''], '/nonexistent')).toEqual([]);
    expect(resolveCompletions(['review', '--until', ''], '/nonexistent')).toEqual([]);
  });

  it('returns empty candidates for unknown subcommands and freeform values', () => {
    expect(resolveCompletions(['frobnicate', ''], '/nonexistent')).toEqual([]);
    expect(resolveCompletions(['run', '--model', ''], '/nonexistent')).toEqual([]);
    expect(resolveCompletions(['review', '--file', ''], '/nonexistent')).toEqual([]);
  });
});


describe('planning skill installation completion', () => {
  it('offers the bundle, options, and comma-separated targets without loading config', () => {
    expect(resolveCompletions(['install', 'pla'], '/nonexistent')).toEqual(['planning-skills']);
    expect(resolveCompletions(['install', 'planning-skills', '--t'], '/nonexistent')).toEqual(['--targets']);
    expect(resolveCompletions(['install', 'planning-skills', '--targets', 'codexcli,cu'], '/nonexistent')).toEqual(['codexcli,cursor']);
    expect(resolveCompletions(['install', 'planning-skills', '--scope', 'u'], '/nonexistent')).toEqual(['user']);
    expect(resolveCompletions(['install', 'planning-skills', ''], '/nonexistent')).toEqual([]);
  });
});
