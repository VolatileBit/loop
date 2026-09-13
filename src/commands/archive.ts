/**
 * `loop archive <project>` — the sequel to `loop polish`. Once a project's
 * nits are cleared and its notes are distilled into the repo's `CONTEXT.md`,
 * everything the project owns moves under one dated folder:
 *
 *   <archiveDir>/<date>-<project>/
 *     issues/           — the project's issue files
 *     planning/         — alternatively, the complete spec project with issues/ and map/
 *     runs/             — .loop/runs/<project>/
 *     handoffs/         — .loop/handoffs/<project>/
 *     notes.md          — .loop/notes/<project>.md
 *     loop.project.json — the project's config entry, wrapped so it is itself a
 *                         valid partial config: restoring is a paste, not a
 *                         transcription
 *
 * **Nothing is deleted.** Reverting is moving folders back. The only removals
 * are directories the move left empty (`rmdirSync`, which refuses on anything
 * non-empty). The plan is computed once and shared by `--dry-run` and the real
 * run, so preview and execution cannot disagree.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ArchiveFlags } from '../cli/args.js';
import { CONFIG_FILE_NAME } from '../config/load-config.js';
import type { LoopConfig } from '../config/types.js';
import type { TriageLabels } from '../config/triage-labels.js';
import { RUNNABLE_TRIAGE_ROLES, issueTriageRole } from '../issues/lifecycle.js';
import type { IssueRecord } from '../issues/types.js';
import { failStop, registerShutdownHandlers } from '../interrupt/shutdown.js';
import { discoverIssues, hasIssueContainer } from '../issues/discovery.js';
import { listProjects } from '../issues/project.js';
import { acquireInvocationLock } from '../shared/lock.js';
import { handoffsDir, runsDir } from '../shared/paths.js';
import { startupCommand } from './startup.js';
import { projectNotesPath } from '../handoff/project-notes.js';

/** One directory or file the archive will relocate. */
export type ArchiveMove = {
  /** Absolute source path. */
  from: string;
  /** Absolute destination path inside the dated archive folder. */
  to: string;
  /** What this is, for the printed plan. */
  label: string;
};

export type ArchivePlan = {
  project: string;
  /** Absolute dated folder everything moves into. */
  destination: string;
  moves: ArchiveMove[];
  /** The `projects.<name>` entry lifted out, or null when the project has none. */
  configEntry: Record<string, unknown> | null;
  /** Issues loop would still claim — archiving these would bury live work. */
  runnable: string[];
  /** Issues waiting on a person; named in the summary but never a blocker. */
  humanOwned: string[];
};

export type ArchiveBlocked = { ok: false; reason: string; details: string[] };
export type ArchiveResult = { ok: true; plan: ArchivePlan } | ArchiveBlocked;

/** `2026-08-01` — the archive folder's date prefix. */
export function archiveDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Build the archive plan, or explain why the project cannot be archived.
 *
 * The runnable check is deliberately against `RUNNABLE_TRIAGE_ROLES` rather
 * than "not done": an issue waiting on a *person* has usually been handled
 * outside loop by the time someone retires the project. Reusing the
 * scheduler's own list states the rule in one line — if the next `loop run`
 * would claim it, archiving really would bury live work.
 */
export function planArchive(options: {
  root: string;
  project: string;
  issues: readonly IssueRecord[];
  config: Pick<LoopConfig, 'issuesDir' | 'projects' | 'archiveDir'>;
  labels: TriageLabels;
  now?: Date;
}): ArchiveResult {
  const { root, project, issues, config, labels } = options;

  if (!config.archiveDir) {
    return {
      ok: false,
      reason: 'archiveDir is not set',
      details: [
        `Archiving moves real directories, so loop refuses until "archiveDir" is set in ${CONFIG_FILE_NAME}.`,
        'Where a repo keeps retired planning material is a shared convention — set it in the tracked config.',
      ],
    };
  }

  const inProject = issues.filter((issue) => issue.project === project);
  if (inProject.length === 0) {
    return { ok: false, reason: `no issues found for project "${project}"`, details: [] };
  }

  const runnable = inProject
    .filter((issue) => {
      const role = issueTriageRole(issue, labels);
      return role !== null && RUNNABLE_TRIAGE_ROLES.includes(role);
    })
    .map((issue) => issue.qualifiedId);
  if (runnable.length > 0) {
    return {
      ok: false,
      reason: `${runnable.length} issue(s) in "${project}" are still runnable`,
      details: [...runnable.map((id) => `  - ${id}`), 'Finish or retire them first — archiving would bury live work.'],
    };
  }

  const destination = path.resolve(
    root,
    config.archiveDir,
    `${archiveDateStamp(options.now)}-${project}`,
  );
  if (existsSync(destination)) {
    return {
      ok: false,
      reason: `${path.relative(root, destination)} already exists`,
      details: ['Archiving never merges into an existing folder — move or rename it first.'],
    };
  }

  const projectDir = path.resolve(root, config.issuesDir, project);
  const planningLayout = hasIssueContainer(projectDir);
  const candidates: ArchiveMove[] = [
    {
      from: projectDir,
      to: path.join(destination, planningLayout ? 'planning' : 'issues'),
      label: planningLayout ? 'spec, issues, and planning context' : 'issue files',
    },
    { from: path.join(runsDir(root), project), to: path.join(destination, 'runs'), label: 'run artifacts' },
    {
      from: path.join(handoffsDir(root), project),
      to: path.join(destination, 'handoffs'),
      label: 'archived handoffs',
    },
    { from: projectNotesPath(root, project), to: path.join(destination, 'notes.md'), label: 'project notes' },
  ];

  return {
    ok: true,
    plan: {
      project,
      destination,
      moves: candidates.filter((move) => existsSync(move.from)),
      configEntry: config.projects[project] ? { ...config.projects[project] } : null,
      runnable,
      humanOwned: inProject
        .filter((issue) => {
          const role = issueTriageRole(issue, labels);
          return role === 'readyForHuman' || role === 'delegatedToHuman' || role === 'needsInfo';
        })
        .map((issue) => issue.qualifiedId),
    },
  };
}

/** Human-readable plan lines, shared by `--dry-run` and the real run's summary. */
export function describeArchivePlan(root: string, plan: ArchivePlan): string[] {
  const lines = [`Archive of "${plan.project}" → ${path.relative(root, plan.destination)}/`];
  for (const move of plan.moves) {
    lines.push(`  ${path.relative(root, move.from)}  →  ${path.relative(root, move.to)}  (${move.label})`);
  }
  if (plan.configEntry) lines.push(`  projects.${plan.project} config entry  →  loop.project.json`);
  if (plan.moves.length === 0 && !plan.configEntry) lines.push('  (nothing to move)');
  if (plan.humanOwned.length > 0) {
    lines.push(`  Note: ${plan.humanOwned.length} issue(s) are still with a human: ${plan.humanOwned.join(', ')}`);
  }
  return lines;
}

/**
 * Execute a plan. Moves are `renameSync`, so the operation is atomic per entry
 * and reversible by moving the folder back.
 */
export function executeArchive(root: string, plan: ArchivePlan): void {
  mkdirSync(plan.destination, { recursive: true });

  for (const move of plan.moves) {
    mkdirSync(path.dirname(move.to), { recursive: true });
    renameSync(move.from, move.to);
    pruneEmptyParent(root, path.dirname(move.from));
  }

  if (plan.configEntry) {
    // Wrapped in a `projects` map so the file is itself a valid partial config.
    writeFileSync(
      path.join(plan.destination, 'loop.project.json'),
      `${JSON.stringify({ projects: { [plan.project]: plan.configEntry } }, null, 2)}\n`,
    );
  }

}

/** Remove a directory the move emptied; `rmdirSync` refuses anything non-empty. */
function pruneEmptyParent(root: string, dir: string): void {
  if (path.resolve(dir) === path.resolve(root)) return;
  try {
    rmdirSync(dir);
  } catch {
    // Not empty (or not ours) — leaving it is the safe outcome.
  }
}

/** The config entry a previously archived project can be pasted back from. */
export function readArchivedConfigEntry(archiveFolder: string): Record<string, unknown> | null {
  const filePath = path.join(archiveFolder, 'loop.project.json');
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `loop archive <project>` entry point. */
export async function archiveCommand(flags: ArchiveFlags): Promise<never> {
  registerShutdownHandlers({});
  const startup = startupCommand({ configOverrides: flags.config, stages: [] });
  const { root, config, labels, workRoot } = startup;

  if (!flags.project) {
    failStop('loop archive needs a project', {
      details: ['Usage: loop archive <project>', 'Projects are the folders under issuesDir.'],
    });
  }
  const project = flags.project;

  const issues = discoverIssues(config.issuesDir, workRoot);
  const known = listProjects(issues);
  const resolved = known.find((name) => name.toLowerCase() === project.toLowerCase());
  if (!resolved) {
    failStop(`unknown project "${project}"`, {
      details: [known.length > 0 ? `Known projects: ${known.join(', ')}` : `No projects found under ${config.issuesDir}/.`],
    });
  }

  const planned = planArchive({ root, project: resolved, issues, config, labels });
  if (!planned.ok) failStop(`cannot archive "${resolved}": ${planned.reason}`, { details: planned.details });

  const lines = describeArchivePlan(root, planned.plan);
  if (flags.dryRun) {
    console.log(['Would archive (dry run):', ...lines].join('\n'));
    process.exit(0);
  }

  // Archiving moves the directories a run reads and writes; take the same
  // per-repo lock every mutating invocation takes.
  let releaseLock: () => void;
  try {
    releaseLock = acquireInvocationLock(root);
  } catch (error) {
    failStop('another loop invocation is running', {
      details: String(error instanceof Error ? error.message : error).split('\n'),
    });
  }
  process.once('exit', () => releaseLock());

  executeArchive(root, planned.plan);
  console.log(lines.join('\n'));
  console.log(
    `\n[loop] archived "${resolved}". Nothing was deleted — move the folder back to restore it, and ` +
      `paste loop.project.json's entry back into ${CONFIG_FILE_NAME}.`,
  );
  if (planned.plan.configEntry) {
    console.log(`[loop] remember to remove projects.${resolved} from ${CONFIG_FILE_NAME}.`);
  }
  process.exit(0);
}
