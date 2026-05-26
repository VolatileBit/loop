/**
 * Candidate resolution for the hidden `loop __complete -- <words...>`
 * command. `words` are the command-line words after `loop` up to the cursor;
 * the last word is the partial being completed (possibly empty).
 *
 * Dynamic candidates (projects, issue ids) load config + discoverIssues() from
 * the working directory — the same modules the real commands use, so
 * completions can't drift from real behavior. Never throws: any error (bad
 * cwd, unreadable config, no issues dir) degrades to an empty candidate list
 * so a broken repo state never breaks the user's shell prompt.
 */

import { loadConfig } from '../config/load-config.js';
import { listGoals } from '../goal/goal.js';
import { discoverIssues } from '../issues/discovery.js';
import { listProjects } from '../issues/project.js';
import type { IssueRecord } from '../issues/types.js';
import { resolveRoot } from '../shared/paths.js';
import {
  COMPLETION_SHELLS,
  FIX_NITS_FLAG_NAMES,
  ARCHIVE_FLAG_NAMES,
  POLISH_FLAG_NAMES,
  FLAG_ENUM_VALUES,
  GOAL_FLAG_NAMES,
  INIT_FLAG_NAMES,
  REVIEW_FLAG_NAMES,
  RUN_FLAG_NAMES,
  SUBCOMMANDS,
  VALUE_FLAGS,
} from './args.js';

function byPrefix(candidates: readonly string[], partial: string): string[] {
  return candidates.filter((candidate) => candidate.startsWith(partial));
}

function loadIssues(root: string): IssueRecord[] {
  const config = loadConfig(root);
  return discoverIssues(config.issuesDir, root);
}

function qualifiedIds(root: string): string[] {
  return loadIssues(root).map((issue) => issue.qualifiedId);
}

/** `PRD-001/issue-01,iss` → keep the committed segments, complete the last one. */
function completeIdsList(partial: string, root: string): string[] {
  const lastComma = partial.lastIndexOf(',');
  const head = lastComma === -1 ? '' : partial.slice(0, lastComma + 1);
  const segment = lastComma === -1 ? partial : partial.slice(lastComma + 1);
  return byPrefix(qualifiedIds(root), segment).map((candidate) => `${head}${candidate}`);
}

/** True when a non-flag positional already appears in `words` (flag values excluded). */
function hasPositional(words: string[]): boolean {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if (word.startsWith('-')) {
      if (VALUE_FLAGS.has(word)) i += 1; // skip the flag's value word
      continue;
    }
    return true;
  }
  return false;
}

const SUBCOMMAND_FLAG_NAMES: Record<'run' | 'review' | 'fix-nits' | 'polish' | 'archive' | 'goal' | 'init', readonly string[]> = {
  run: RUN_FLAG_NAMES,
  review: REVIEW_FLAG_NAMES,
  'fix-nits': FIX_NITS_FLAG_NAMES,
  polish: POLISH_FLAG_NAMES,
  archive: ARCHIVE_FLAG_NAMES,
  goal: GOAL_FLAG_NAMES,
  init: INIT_FLAG_NAMES,
};

function completeRunOrReview(
  sub: 'run' | 'review' | 'fix-nits' | 'polish' | 'archive' | 'goal' | 'init',
  prior: string[],
  partial: string,
  root: string,
): string[] {
  const prev = prior[prior.length - 1];

  if (prev !== undefined && prev.startsWith('-')) {
    const enumValues = FLAG_ENUM_VALUES[prev];
    if (enumValues) return byPrefix(enumValues, partial);
    if (prev === '--until') return byPrefix(qualifiedIds(root), partial);
    if (prev === '--ids') return completeIdsList(partial, root);
    if (VALUE_FLAGS.has(prev)) return []; // freeform value (path, number, model name)
  }

  if (partial.startsWith('-')) {
    return byPrefix(SUBCOMMAND_FLAG_NAMES[sub], partial);
  }

  if ((sub === 'run' || sub === 'polish' || sub === 'archive') && !hasPositional(prior.slice(1))) {
    return byPrefix(listProjects(loadIssues(root)), partial);
  }

  if (sub === 'goal' && !hasPositional(prior.slice(1))) {
    return byPrefix(
      listGoals(root).map((goal) => goal.slug),
      partial,
    );
  }

  return [];
}

export function resolveCompletions(words: string[], root: string = resolveRoot()): string[] {
  try {
    const partial = words.length > 0 ? words[words.length - 1]! : '';
    const prior = words.slice(0, -1);

    if (prior.length === 0) {
      return byPrefix(SUBCOMMANDS, partial);
    }

    const sub = prior[0]!;

    if (
      sub === 'run' ||
      sub === 'review' ||
      sub === 'fix-nits' ||
      sub === 'polish' ||
      sub === 'archive' ||
      sub === 'goal' ||
      sub === 'init'
    ) {
      return completeRunOrReview(sub, prior, partial, root);
    }

    if (sub === 'goals') {
      return partial.startsWith('-') ? byPrefix(['--help'], partial) : [];
    }

    if (sub === 'completion') {
      if (partial.startsWith('-')) return byPrefix(['--help'], partial);
      if (hasPositional(prior.slice(1))) return [];
      return byPrefix(COMPLETION_SHELLS, partial);
    }

    if (sub === 'list-runs') {
      return partial.startsWith('-') ? byPrefix(['--help'], partial) : [];
    }

    return [];
  } catch {
    return [];
  }
}
