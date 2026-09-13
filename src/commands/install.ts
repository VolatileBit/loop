import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLANNING_SKILL_TARGETS, type InstallFlags, type InstallScope, type PlanningSkillTarget } from '../cli/args.js';
import { askChoice, createAsker, type Asker } from '../cli/ask.js';
import { failStop } from '../interrupt/shutdown.js';
import { resolveRoot } from '../shared/paths.js';

const TARGET_DIRS: Record<PlanningSkillTarget, string> = {
  claudecode: '.claude/skills', codexcli: '.agents/skills', cursor: '.cursor/skills', copilot: '.github/skills',
};
const SOURCE_DIR = fileURLToPath(new URL('../skills/planning/', import.meta.url));

/** Explicit scope skips prompting; scripts retain the existing project default. */
export async function chooseInstallScope(
  flags: Pick<InstallFlags, 'scope'>, interactive: boolean, asker?: Asker,
): Promise<InstallScope> {
  if (flags.scope) return flags.scope;
  if (!interactive) return 'project';
  const input = asker ?? createAsker();
  try {
    return await askChoice(input, 'Where should the planning skills be installed?', [
      { label: `This project (${resolveRoot()})`, value: 'project' as const },
      { label: `This user (${homedir()}, across projects)`, value: 'user' as const },
    ]);
  } finally {
    input.close();
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(file);
    if (!entry.isFile()) throw new Error(`Expected a regular skill file: ${file}`);
    return [file];
  });
}

/** Reject redirected output paths even with --force; never follow a user skill symlink. */
function inspectDestination(root: string, relative: string): ReturnType<typeof lstatSync> | null {
  const segments = relative.split(path.sep);
  let current = root;
  let stat: ReturnType<typeof lstatSync> | null = null;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]!);
    try { stat = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink() || (i < segments.length - 1 && !stat.isDirectory())) {
      throw new Error(`Cannot install through a symlink or non-directory: ${current}`);
    }
  }
  return stat;
}

/** Generate in isolation first, then preflight every destination before copying any file. */
export async function installPlanningSkills(
  root: string, flags: Pick<InstallFlags, 'targets' | 'force' | 'dryRun' | 'scope'>,
): Promise<{ written: string[]; unchanged: string[] }> {
  const targets = [...new Set(flags.targets)];
  if (!targets.length || targets.some((target) => !PLANNING_SKILL_TARGETS.includes(target))) {
    throw new Error(`Choose targets from: ${PLANNING_SKILL_TARGETS.join(', ')}`);
  }
  const staging = mkdtempSync(path.join(tmpdir(), 'loop-planning-skills-'));
  try {
    const source = path.join(staging, '.rulesync', 'skills');
    mkdirSync(path.dirname(source), { recursive: true });
    cpSync(SOURCE_DIR, source, { recursive: true });
    const configPath = path.join(staging, 'rulesync.jsonc');
    writeFileSync(configPath, JSON.stringify({ targets, features: ['skills'], global: false, delete: false }));
    try {
      // Load only for installation; other Loop commands do not initialize rulesync.
      const { generate } = await import('rulesync');
      const generated = await generate({
        // inputRoot also anchors rulesync's config-path validation inside staging.
        configPath, targets, features: ['skills'], inputRoot: staging,
        outputRoots: [staging], global: false, delete: false, silent: true,
      });
      if (generated.sourceLoadFailed) throw new Error('Could not load the complete planning skill source.');
    } catch (error) {
      throw new Error(`rulesync generation failed; no installed skills were changed.\n${error instanceof Error ? error.message : String(error)}`);
    }
    const skillNames = readdirSync(SOURCE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const pending: { source: string; relative: string }[] = [];
    const unchanged: string[] = [];
    const conflicts: string[] = [];
    for (const target of targets) {
      // Generate in project mode: rulesync's global mode ignores outputRoots and
      // writes straight into the real home, bypassing preview and conflict checks.
      const destinationDir = flags.scope === 'user' && target === 'copilot'
        ? '.copilot/skills' : TARGET_DIRS[target];
      for (const skill of skillNames) {
        const directory = path.join(staging, TARGET_DIRS[target], skill);
        // A successful process without the complete bundle is not a successful install.
        if (!readFileSync(path.join(directory, 'SKILL.md'), 'utf8').trim()) {
          throw new Error(`rulesync produced an empty skill for ${target}/${skill}`);
        }
        for (const companion of filesUnder(path.join(source, skill))) {
          const relative = path.relative(path.join(source, skill), companion);
          const output = path.join(directory, relative);
          if (!lstatSync(output, { throwIfNoEntry: false })?.isFile()) {
            throw new Error(`rulesync omitted a required skill file: ${target}/${skill}/${relative}`);
          }
        }
        for (const sourceFile of filesUnder(directory)) {
          const relative = path.join(destinationDir, skill, path.relative(directory, sourceFile));
          const stat = inspectDestination(root, relative);
          if (stat && !stat.isFile()) throw new Error(`Expected a file at ${path.join(root, relative)}`);
          if (stat && readFileSync(path.join(root, relative)).equals(readFileSync(sourceFile))) {
            unchanged.push(relative);
          } else {
            if (stat && !flags.force) conflicts.push(relative);
            pending.push({ source: sourceFile, relative });
          }
        }
      }
    }
    if (conflicts.length) {
      throw new Error(`Existing skills differ; no files changed. Review these files, then use --force to overwrite:\n${conflicts.join('\n')}`);
    }
    if (!flags.dryRun) {
      for (const file of pending) {
        const destination = path.join(root, file.relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(file.source, destination);
      }
    }
    return { written: pending.map((file) => file.relative), unchanged };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function installCommand(flags: InstallFlags): Promise<never> {
  try {
    const scope = await chooseInstallScope(flags, flags.interactive || (process.stdin.isTTY === true && process.stdout.isTTY === true));
    const root = scope === 'user' ? homedir() : resolveRoot();
    console.log(`[loop] installation scope: ${scope} (${root})`);
    const result = await installPlanningSkills(root, { ...flags, scope });
    console.log(`[loop] ${flags.dryRun ? 'would install' : 'installed'} ${result.written.length} planning skill files; ${result.unchanged.length} already current.`);
    for (const file of result.written) console.log(`  ${path.join(root, file)}`);
    process.exit(0);
  } catch (error) {
    failStop('planning skills could not be installed', { details: [error instanceof Error ? error.message : String(error)] });
  }
}
