import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTempDirs, makeTempRoot } from '../issues/test-helpers.js';
import {
  createGoal,
  declaredVerifyPath,
  goalExists,
  goalPaths,
  listDeclaredVerifyCmds,
  listGoals,
  loadGoalState,
  readDeclaredVerifyCmd,
  saveGoalState,
  slugifyGoal,
  updateLineageFromIssues,
} from './goal.js';
import { parseGoalVerdict } from './prompts.js';

afterEach(cleanupTempDirs);

describe('slugifyGoal', () => {
  it('derives a filesystem-safe slug', () => {
    expect(slugifyGoal('Migrate every API route to the new gateway client!')).toBe(
      'migrate-every-api-route-to-the-new-gatew',
    );
    expect(slugifyGoal('  ---  ')).toBe('goal');
  });
});

describe('goal folder + state', () => {
  it('creates the skeleton and round-trips state', () => {
    const root = makeTempRoot('loop-goal-');
    const paths = createGoal(root, 'gateway', 'Migrate every route.');
    expect(goalExists(root, 'gateway')).toBe(true);
    expect(loadGoalState(paths)).toMatchObject({ round: 0, status: 'active', lineage: {} });

    saveGoalState(paths, { round: 3, status: 'active', lineage: { '02-b': '01-a' }, createdAt: 'x' });
    expect(loadGoalState(paths)).toMatchObject({ round: 3, lineage: { '02-b': '01-a' } });
  });

  it('reads declared verify commands, skipping comments and blanks', () => {
    const root = makeTempRoot('loop-goal-');
    const paths = createGoal(root, 'g', 'text');
    expect(readDeclaredVerifyCmd(paths, '01-x')).toBeNull();

    writeFileSync(declaredVerifyPath(paths, '01-x'), '# chosen because...\n\npnpm --filter web test\n');
    expect(readDeclaredVerifyCmd(paths, '01-x')).toBe('pnpm --filter web test');

    writeFileSync(declaredVerifyPath(paths, '02-y'), 'pnpm typecheck\n');
    expect([...listDeclaredVerifyCmds(paths).entries()]).toEqual([
      ['01-x', 'pnpm --filter web test'],
      ['02-y', 'pnpm typecheck'],
    ]);
  });

  it('lists goals with status, round, and headline', () => {
    const root = makeTempRoot('loop-goal-');
    createGoal(root, 'alpha', '# Ship the alpha\nmore text');
    const beta = createGoal(root, 'beta', 'Do the beta thing');
    saveGoalState(beta, { round: 2, status: 'reached', lineage: {}, createdAt: 'x' });

    const goals = listGoals(root);
    expect(goals.map((goal) => goal.slug)).toEqual(['alpha', 'beta']);
    expect(goals[0]).toMatchObject({ status: 'active', round: 0, headline: 'Ship the alpha' });
    expect(goals[1]).toMatchObject({ status: 'reached', round: 2 });
  });
});

describe('updateLineageFromIssues', () => {
  function writeIssue(dir: string, id: string, supersedes?: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${id}.md`),
      `---\nid: ${id}\ntitle: ${id}\ntriage: ready\n---\n${supersedes ? `Supersedes: ${supersedes}\n` : ''}\nbody\n`,
    );
  }

  it('folds Supersedes lines into the lineage and flags lineages past the supersede limit', () => {
    const root = makeTempRoot('loop-goal-');
    const paths = createGoal(root, 'g', 'text');
    writeIssue(paths.issuesProjectDir, '01-a');
    writeIssue(paths.issuesProjectDir, '02-b', '01-a');

    const first = updateLineageFromIssues(paths, {}, 3);
    expect(first).toEqual({ lineage: { '02-b': '01-a' }, overLimit: [] });

    // Chains flatten to the root; two more replacements stay within limit 3.
    writeIssue(paths.issuesProjectDir, '03-c', '02-b');
    writeIssue(paths.issuesProjectDir, '04-d', '03-c');
    const third = updateLineageFromIssues(paths, first.lineage, 3);
    expect(third.overLimit).toEqual([]);
    expect(third.lineage).toEqual({ '02-b': '01-a', '03-c': '01-a', '04-d': '01-a' });

    // The fourth replacement of the same problem crosses the limit.
    writeIssue(paths.issuesProjectDir, '05-e', '04-d');
    const fourth = updateLineageFromIssues(paths, third.lineage, 3);
    expect(fourth.overLimit).toEqual(['01-a']);

    // A tighter limit flags earlier.
    expect(updateLineageFromIssues(paths, {}, 1).overLimit).toEqual(['01-a']);
  });
});

describe('parseGoalVerdict', () => {
  it('parses the three verdicts, requiring gaps for not-reached', () => {
    expect(
      parseGoalVerdict('prose\n\n## Loop goal verdict\nstatus: reached\nsummary: all routes migrated\n'),
    ).toEqual({ status: 'reached', summary: 'all routes migrated', gaps: [] });

    expect(
      parseGoalVerdict(
        '## Loop goal verdict\nstatus: not-reached\nsummary: two routes left\n\n## Loop goal gaps\n- migrate /billing\n- migrate /admin\n',
      ),
    ).toEqual({
      status: 'not-reached',
      summary: 'two routes left',
      gaps: ['migrate /billing', 'migrate /admin'],
    });

    expect(parseGoalVerdict('## Loop goal verdict\nstatus: blocked\nsummary: goal is ambiguous\n').status).toBe(
      'blocked',
    );
  });

  it('throws on missing block, unknown status, or gapless not-reached', () => {
    expect(() => parseGoalVerdict('no verdict here')).toThrow(/no "## Loop goal verdict" block/);
    expect(() => parseGoalVerdict('## Loop goal verdict\nstatus: maybe\nsummary: x')).toThrow(
      /must be reached\|not-reached\|blocked/,
    );
    expect(() => parseGoalVerdict('## Loop goal verdict\nstatus: not-reached\nsummary: x')).toThrow(
      /must list concrete gaps/,
    );
  });
});

describe('goalPaths', () => {
  it('keeps the slug as the issues project folder (qualifiedIds read <slug>/<id>)', () => {
    const paths = goalPaths('/repo', 'gateway');
    expect(paths.issuesProjectDir).toBe(path.join('/repo', '.loop', 'goals', 'gateway', 'issues', 'gateway'));
  });
});
