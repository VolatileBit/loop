import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { askChoice, askWithDefault, askYesNo, type Asker } from '../cli/ask.js';
import type { InitFlags } from '../cli/args.js';
import { discoverIssues, hasIssueContainer } from '../issues/discovery.js';
import { parseFrontmatter, resolveIssueId, resolveSpecPointer } from '../issues/frontmatter.js';
import { findProjectSpecs } from '../issues/resolve-spec.js';

export type PlanningPaths = { issuesDirs: string[]; specsDirs: string[] };
export type InitProject = { name: string; verifyCmd?: string; spec?: string };

function isDirectory(file: string): boolean {
  try { return statSync(file).isDirectory(); } catch { return false; }
}

/** Filesystem suggestions are independent of an agent session, including --no-discovery. */
export function discoverPlanningPaths(root: string, archiveDir?: string): PlanningPaths {
  const issuesDirs = new Set<string>();
  const specsDirs = new Set<string>();
  for (const dir of ['issues', 'docs/issues', 'tasks', 'work/issues']) {
    if (isDirectory(path.join(root, dir))) issuesDirs.add(dir);
  }
  for (const dir of ['specs', 'docs/specs', 'docs/prd', 'docs/prds', 'prd', 'prds']) {
    if (isDirectory(path.join(root, dir))) specsDirs.add(dir);
  }
  // Git supplies tracked and untracked files while excluding ignored build trees.
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.status !== 0) return { issuesDirs: [...issuesDirs], specsDirs: [...specsDirs] };
  const archiveRoot = archiveDir ? path.resolve(root, archiveDir) : null;
  for (const file of new Set(listed.stdout.split('\0'))) {
    if (!file.endsWith('.md') || file.split('/').some((part) =>
      part.startsWith('.') || ['node_modules', 'vendor', 'archive', 'archives'].includes(part))) continue;
    const absolute = path.resolve(root, file);
    if (archiveRoot && (absolute === archiveRoot || absolute.startsWith(`${archiveRoot}${path.sep}`))) continue;
    try {
      const { frontmatter } = parseFrontmatter(readFileSync(absolute, 'utf8'));
      if (resolveIssueId(frontmatter) && frontmatter.triage) {
        const folder = path.dirname(file);
        const parent = path.basename(folder) === 'issues'
          ? path.dirname(path.dirname(folder))
          : path.dirname(folder);
        if (parent !== '.') issuesDirs.add(parent);
        const spec = resolveSpecPointer(frontmatter);
        if (spec && statSync(path.resolve(root, spec), { throwIfNoEntry: false })?.isFile()) {
          const specParent = path.basename(spec) === 'spec.md' ? path.dirname(path.dirname(spec)) : path.dirname(spec);
          if (specParent !== '.') specsDirs.add(specParent);
        }
      } else if (path.basename(file) === 'spec.md') {
        const parent = path.dirname(path.dirname(file));
        if (parent !== '.') {
          specsDirs.add(parent);
          issuesDirs.add(parent);
        }
      }
    } catch {
      // A deleted tracked file or unreadable candidate does not stop setup.
    }
  }
  return { issuesDirs: [...issuesDirs], specsDirs: [...specsDirs] };
}

export type PlanningProject = { name: string; specs: string[] };

/** Existing project entries are optional overrides, not a prerequisite for discovery. */
export function discoverPlanningProjects(
  root: string, issuesDir: string, specsDir: string | null, registered: Record<string, unknown>,
): PlanningProject[] {
  const issues = discoverIssues(issuesDir, root);
  const names = new Set([...issues.map((issue) => issue.project), ...Object.keys(registered)]);
  const addFolders = (dir: string, specOnly: boolean): void => {
    if (!isDirectory(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const folder = path.join(dir, entry.name);
      if (specOnly ? existsSync(path.join(folder, 'spec.md')) :
        hasIssueContainer(folder) || existsSync(path.join(folder, 'spec.md')) ||
        !readdirSync(folder, { withFileTypes: true }).some((child) => child.isDirectory())) {
        names.add(entry.name);
      }
    }
  };
  addFolders(path.resolve(root, issuesDir), false);
  if (specsDir) {
    const specRoot = path.resolve(root, specsDir);
    addFolders(specRoot, true);
    if (isDirectory(specRoot)) {
      for (const entry of readdirSync(specRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md') || /^(?:readme|spec)\.md$/i.test(entry.name)) continue;
        const relative = path.relative(root, path.join(specRoot, entry.name));
        // A flat spec already matching an issue project does not create another slug.
        if ([...names].some((name) => findProjectSpecs(name, specsDir, root).includes(relative))) continue;
        names.add(entry.name.replace(/\.md$/, ''));
      }
    }
  }
  return [...names].filter((name) => !Object.hasOwn(registered, name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => {
      const linked = issues.filter((issue) => issue.project === name && issue.spec)
        .map((issue) => issue.spec!).filter((file) => {
          try { return statSync(path.resolve(root, file)).isFile(); } catch { return false; }
        });
      return { name, specs: [...new Set([...linked, ...(specsDir ? findProjectSpecs(name, specsDir, root) : [])])] };
    });
}

async function askPath(asker: Asker, prompt: string, candidates: string[], fallback: string): Promise<string> {
  const choices = [...new Set(candidates)];
  if (choices.length < 2) return askWithDefault(asker, prompt, choices[0] ?? fallback);
  const selected = await askChoice(asker, prompt, [
    ...choices.map((value) => ({ label: value, value })),
    { label: 'Custom path', value: '' },
    ...(fallback === 'none' ? [{ label: 'None', value: 'none' }] : []),
  ]);
  return selected || askWithDefault(asker, prompt, fallback);
}

/** Ask only about missing paths and unregistered projects; explicit flags skip questions. */
export async function gatherPlanningAnswers(
  root: string, asker: Asker, flags: InitFlags, existing: Record<string, unknown>,
  suggested: { issuesDir: string | null; specsDir: string | null },
): Promise<{ issuesDir: string | null; specsDir: string | null; projects: InitProject[] }> {
  const found = discoverPlanningPaths(root, typeof existing.archiveDir === 'string' ? existing.archiveDir : undefined);
  const issuesDir = typeof existing.issuesDir === 'string' ? existing.issuesDir : flags.issuesDir ??
    await askPath(asker, 'Issues root (contains project folders)', [
      ...found.issuesDirs, ...(suggested.issuesDir ? [suggested.issuesDir] : []),
    ], 'specs');
  const specsAnswer = typeof existing.specsDir === 'string' ? existing.specsDir : flags.specsDir ??
    await askPath(asker, 'Specs directory (or none)', [
      ...found.specsDirs, ...(suggested.specsDir ? [suggested.specsDir] : []),
    ], 'specs');
  const specsDir = specsAnswer.toLowerCase() === 'none' ? null : specsAnswer;
  const registered = typeof existing.projects === 'object' && existing.projects !== null
    ? existing.projects as Record<string, unknown> : {};
  const candidates = discoverPlanningProjects(root, issuesDir, specsDir, registered);
  const projects: InitProject[] = [];
  const askProject = async (name: string, specs: string[]): Promise<void> => {
    if (!name.trim() || name === '.' || name === '..' || /[/\\\s]/.test(name)) {
      throw new Error('Project name must be a single folder name without whitespace.');
    }
    if (Object.hasOwn(registered, name) || projects.some((project) => project.name === name)) {
      throw new Error(`projects.${name} already exists — init never overwrites an existing project entry.`);
    }
    const spec = flags.project === name && flags.projectSpec ? flags.projectSpec :
      await askPath(asker, `Spec path for ${name} (or none)`, specs, 'none');
    const verify = flags.project === name && flags.projectVerifyCmd ? flags.projectVerifyCmd :
      await askWithDefault(asker, `Verify command for ${name} (or none to inherit)`, 'none');
    projects.push({ name, ...(spec.toLowerCase() === 'none' ? {} : { spec }),
      ...(verify.toLowerCase() === 'none' ? {} : { verifyCmd: verify }) });
  };
  if (flags.project) {
    await askProject(flags.project, candidates.find((candidate) => candidate.name === flags.project)?.specs ??
      (specsDir ? findProjectSpecs(flags.project, specsDir, root) : []));
  } else {
    for (const candidate of candidates) {
      if (await askYesNo(asker, `Register discovered project ${candidate.name}?`, true)) {
        await askProject(candidate.name, candidate.specs);
      }
    }
    if (await askYesNo(asker, 'Add a custom project override?', false)) {
      const name = await askWithDefault(asker, 'Project folder name');
      await askProject(name, specsDir ? findProjectSpecs(name, specsDir, root) : []);
    }
  }
  return { issuesDir: existing.issuesDir !== undefined ? null : issuesDir,
    specsDir: existing.specsDir !== undefined ? null : specsDir, projects };
}
