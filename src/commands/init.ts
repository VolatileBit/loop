/**
 * `loop init` — guided setup. Detects installed agent CLIs, optionally runs a
 * throwaway discovery session that learns the repo (candidate verify command —
 * validated by actually executing it — plus spec and issue-dir candidates),
 * combines that with filesystem path/project discovery, asks with suggested defaults, and
 * writes `loop.config.json`.
 *
 * Existing configs are extended, never clobbered: keys that already have a
 * value are kept (and shown), only missing keys and new `projects` entries are
 * written. Non-TTY runs use the flag-driven form (no discovery, no questions);
 * `--interactive` forces the guided flow even when piped — answers can be
 * piped in up front thanks to the buffered asker (src/cli/ask.ts).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runAgent, extractAgentResultText } from '../agent/run-agent.js';
import { resolveAgentProvider } from '../agent/providers/index.js';
import { askChoice, askWithDefault, createAsker, type Asker } from '../cli/ask.js';
import type { InitFlags } from '../cli/args.js';
import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  LOCAL_CONFIG_FILE_NAME,
  loadConfig,
  mergeRawConfigs,
  normalizeSpecConfig,
} from '../config/load-config.js';
import { AGENT_CLIS, type AgentCli } from '../config/types.js';
import { isGitRepository } from '../git/status.js';
import { failStop } from '../interrupt/shutdown.js';
import { resolveRoot } from '../shared/paths.js';
import { shell } from '../shared/shell.js';
import { gatherPlanningAnswers, type InitProject } from './init-planning.js';

export const LOOP_DISCOVERY_HEADING = '## Loop discovery';

export type DiscoveryReport = {
  verifyCmd: string | null;
  issuesDir: string | null;
  specsDir: string | null;
};

/**
 * Parse the discovery session's report block:
 *
 *   ## Loop discovery
 *   verify: <command or none>
 *   issues-dir: <dir or none>
 *   specs-dir: <dir or none>
 *
 * Absent/`none` fields resolve to null; a missing block resolves to an empty
 * report (discovery is best-effort — init just falls back to plain defaults).
 */
export function parseDiscoveryReport(text: string): DiscoveryReport {
  const empty: DiscoveryReport = { verifyCmd: null, issuesDir: null, specsDir: null };
  const match = text.match(/## Loop discovery\s*\n([\s\S]*?)(?:\n## |$)/i);
  if (!match) return empty;
  const block = match[1] ?? '';

  const field = (name: string): string | null => {
    const value = block.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1]?.trim() ?? null;
    if (!value || value.toLowerCase() === 'none') return null;
    return value;
  };

  return { verifyCmd: field('verify'), issuesDir: field('issues-dir'), specsDir: field('specs-dir') };
}

/** The subset of loop.config.json that init may write. */
export type InitAnswers = {
  agentCli: AgentCli;
  verifyCmd: string | null;
  issuesDir: string | null;
  specsDir: string | null;
  project: InitProject | null;
  projects?: InitProject[];
};

export type MergeOutcome = {
  config: Record<string, unknown>;
  written: string[];
  kept: string[];
};

/**
 * Fold answers into the existing raw config: existing values always win (and
 * are reported as kept); a `projects` entry may only be added when the name is
 * new. Throws when asked to add a project entry that already exists — init
 * refuses to overwrite an existing feature.
 */
export function mergeInitConfig(
  existing: Record<string, unknown>,
  answers: InitAnswers,
  /** The tracked config merged with any machine-local overlay; defaults to `existing`. */
  effective: Record<string, unknown> = existing,
): MergeOutcome {
  const config = normalizeSpecConfig(existing);
  effective = normalizeSpecConfig(effective);
  const written: string[] = [];
  const kept: string[] = [];
  if (Object.hasOwn(existing, 'prdsDir')) written.push('specsDir');
  if (typeof existing.projects === 'object' && existing.projects !== null) {
    for (const [name, entry] of Object.entries(existing.projects)) {
      if (typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'prd')) {
        written.push(`projects.${name}.spec`);
      }
    }
  }

  const set = (key: string, value: unknown): void => {
    if (value === null || value === undefined) return;
    // Judged against the merged view so a locally-set key is not duplicated
    // into the tracked file, where the two would then disagree.
    if (effective[key] !== undefined) {
      kept.push(key);
      return;
    }
    config[key] = value;
    written.push(key);
  };

  set('agentCli', answers.agentCli);
  set('verifyCmd', answers.verifyCmd);
  set('issuesDir', answers.issuesDir === 'issues' ? null : answers.issuesDir);
  set('specsDir', answers.specsDir);

  for (const project of [...(answers.projects ?? []), ...(answers.project ? [answers.project] : [])]) {
    const projects =
      typeof config.projects === 'object' && config.projects !== null && !Array.isArray(config.projects)
        ? { ...(config.projects as Record<string, unknown>) }
        : {};
    const effectiveProjects =
      typeof effective.projects === 'object' && effective.projects !== null && !Array.isArray(effective.projects)
        ? (effective.projects as Record<string, unknown>)
        : {};
    if (Object.hasOwn(effectiveProjects, project.name) || Object.hasOwn(projects, project.name)) {
      throw new Error(
        `projects.${project.name} already exists in ${CONFIG_FILE_NAME} — init never overwrites an existing project entry; edit it directly.`,
      );
    }
    config.projects = { ...projects, [project.name]: {
      ...(project.verifyCmd ? { verifyCmd: project.verifyCmd } : {}),
      ...(project.spec ? { spec: project.spec } : {}),
    } };
    written.push(`projects.${project.name}`);
  }

  return { config, written, kept };
}

/**
 * Ensure loop's runtime state is gitignored. `.loop/` and the machine-local
 * config overlay are documented as gitignored and warned about at setup, but
 * were never actually added — and an unignored `.loop/` puts run artifacts in
 * the diff, where a later review-fix session "cleaning up" stray files can
 * delete the live run directory mid-run.
 *
 * Writes to `.gitignore` rather than `.git/info/exclude`, since this is a
 * repo-wide fact, and only for paths git does not already ignore by any
 * mechanism. The edit is announced, never silent.
 */
export function ensureRuntimeStateIgnored(root: string): string[] {
  const candidates = ['.loop/', LOCAL_CONFIG_FILE_NAME];
  const missing = candidates.filter(
    (entry) => !shell(`git check-ignore -q ${JSON.stringify(entry)}`, root).ok,
  );
  if (missing.length === 0) return [];

  const gitignorePath = path.join(root, '.gitignore');
  const existingText = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const separator = existingText === '' || existingText.endsWith('\n') ? '' : '\n';
  writeFileSync(
    gitignorePath,
    `${existingText}${separator}\n# loop runtime state\n${missing.join('\n')}\n`,
  );
  return missing;
}

function detectInstalledAgents(): AgentCli[] {
  return AGENT_CLIS.filter((cli) => shell(`command -v ${resolveAgentProvider(cli).binaryName}`).ok);
}

const DISCOVERY_PROMPT = [
  'Inspect this repository to help set up an autonomous issue-runner. **Read-only**: do not create, modify, or delete anything, and do not run package installs.',
  '',
  'Find:',
  '1. The single shell command that best verifies the repo (typecheck + tests, e.g. `pnpm verify`, `npm test`, `cargo test`). Prefer what package.json scripts / Makefile / CI configs actually use. Run it if it is safe and fast enough to confirm it executes.',
  '2. Where markdown issues/tasks live, if such a directory exists.',
  '3. Where specs live, if such a directory exists.',
  '',
  'End your final response with **exactly** this block (use `none` when the repo has no answer):',
  '',
  LOOP_DISCOVERY_HEADING,
  'verify: <command or none>',
  'issues-dir: <repo-relative dir or none>',
  'specs-dir: <repo-relative dir or none>',
].join('\n');

/** Discovery session timeouts — a repo survey must not get 2 hours. */
const DISCOVERY_WALL_MS = 15 * 60 * 1000;
const DISCOVERY_IDLE_MS = 5 * 60 * 1000;

export async function initCommand(flags: InitFlags): Promise<never> {
  const root = resolveRoot();
  if (!isGitRepository(root)) {
    failStop('cwd must be a git repository', {
      details: [`loop operates on the repository at the current working directory (${root}).`],
    });
  }

  const configPath = path.join(root, CONFIG_FILE_NAME);
  const readJson = (filePath: string, fileName: string): Record<string, unknown> => {
    if (!existsSync(filePath)) return {};
    try {
      return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      failStop(`${fileName} exists but is not valid JSON`, {
        details: [String(error instanceof Error ? error.message : error), 'Fix or remove it, then re-run loop init.'],
      });
    }
  };

  // Written into the tracked config, but "already answered" is judged against
  // the *merged* view — a key set only in the machine-local overlay must not be
  // written again here, or the two files would disagree.
  const existing = readJson(configPath, CONFIG_FILE_NAME);
  const localPath = path.join(root, LOCAL_CONFIG_FILE_NAME);
  const local = readJson(localPath, LOCAL_CONFIG_FILE_NAME);
  const effective = mergeRawConfigs(existing, local);
  if (existsSync(configPath)) {
    console.log(`[loop] ${CONFIG_FILE_NAME} exists — init will only fill missing keys and add new projects entries.`);
  }
  if (existsSync(localPath)) {
    console.log(`[loop] ${LOCAL_CONFIG_FILE_NAME} exists — keys it sets are treated as already answered.`);
  }

  const installed = detectInstalledAgents();
  if (installed.length === 0) {
    failStop('no agent CLI found on PATH', {
      details: [`Install at least one of: ${AGENT_CLIS.map((cli) => resolveAgentProvider(cli).binaryName).join(', ')}.`],
    });
  }
  console.log(`[loop] installed agent CLIs: ${installed.join(', ')}`);

  const interactive = flags.interactive || (process.stdin.isTTY === true && process.stdout.isTTY === true);

  const answers = interactive
    ? await gatherInteractive(flags, effective, installed)
    : gatherFromFlags(flags, effective, installed);

  let merged: MergeOutcome;
  try {
    merged = mergeInitConfig(existing, answers, effective);
  } catch (error) {
    failStop('init cannot write the config', {
      details: [String(error instanceof Error ? error.message : error)],
    });
  }

  writeFileSync(configPath, `${JSON.stringify(merged.config, null, 2)}\n`);
  // Confirm the written file round-trips through the real loader.
  try {
    loadConfig(root);
  } catch (error) {
    failStop(`${CONFIG_FILE_NAME} was written but fails validation`, {
      details: [String(error instanceof Error ? error.message : error)],
    });
  }

  if (merged.kept.length > 0) console.log(`[loop] kept existing: ${merged.kept.join(', ')}`);
  console.log(
    merged.written.length > 0
      ? `[loop] wrote ${CONFIG_FILE_NAME}: ${merged.written.join(', ')}`
      : `[loop] ${CONFIG_FILE_NAME} already had every answered key — nothing to write.`,
  );
  const ignored = ensureRuntimeStateIgnored(root);
  if (ignored.length > 0) {
    console.log(`[loop] added to .gitignore: ${ignored.join(', ')} (loop's runtime state must not enter the diff).`);
  }
  console.log(`[loop] next: review project folders under ${String(merged.config.issuesDir ?? effective.issuesDir ?? 'issues')}/ (planning issues live in <project>/issues/), then \`loop run --dry-run\`.`);
  process.exit(0);
}

function gatherFromFlags(
  flags: InitFlags,
  existing: Record<string, unknown>,
  installed: AgentCli[],
): InitAnswers {
  const agentCli = flags.agentCli ?? (existing.agentCli as AgentCli | undefined) ?? installed[0]!;
  const verifyCmd = flags.verifyCmd ?? null;
  if (!verifyCmd && existing.verifyCmd === undefined) {
    failStop('non-interactive init requires --verify-cmd', {
      details: ['Pass --verify-cmd "<typecheck+test command>" (or run in a terminal / with --interactive).'],
    });
  }
  return {
    agentCli,
    verifyCmd,
    issuesDir: flags.issuesDir ?? (Object.keys(existing).length === 0 ? 'specs' : null),
    specsDir: flags.specsDir ?? (Object.keys(existing).length === 0 ? 'specs' : null),
    project: flags.project
      ? {
          name: flags.project,
          ...(flags.projectVerifyCmd ? { verifyCmd: flags.projectVerifyCmd } : {}),
          ...(flags.projectSpec ? { spec: flags.projectSpec } : {}),
        }
      : null,
  };
}

/**
 * Ask for the verify command and trial it the same way the discovery session
 * must trial its own. A command that cannot *execute* is re-asked — writing it
 * into the config would surface only later, as every issue fails "command not
 * found" after three fix cycles apiece. A command that runs and merely fails is
 * kept: a red suite is a fact about the repo, not about the answer.
 */
async function askVerifyCommand(asker: Asker, suggested?: string): Promise<string> {
  for (;;) {
    const verifyCmd = await askWithDefault(
      asker,
      'Verify command (typecheck + tests, run after every agent session)',
      suggested,
    );
    console.log(`[loop] validating: ${verifyCmd}`);
    const validation = shell(verifyCmd, resolveRoot());
    if (validation.ok) {
      console.log('[loop] verify command passed.');
      return verifyCmd;
    }
    // 127 = not found, 126 = found but not executable.
    if (validation.code === 127 || validation.code === 126 || /command not found|not recognized/i.test(validation.output)) {
      console.warn(`[loop] \`${verifyCmd}\` cannot run here (exit ${validation.code ?? '?'}) — please enter a command that exists.`);
      continue;
    }
    console.warn(
      `[loop] warning: \`${verifyCmd}\` exited ${validation.code ?? '?'} — keeping it anyway; fix the command (or the repo) before long runs.`,
    );
    return verifyCmd;
  }
}

async function gatherInteractive(
  flags: InitFlags,
  existing: Record<string, unknown>,
  installed: AgentCli[],
): Promise<InitAnswers> {
  const asker = createAsker();
  try {
    const existingAgent = existing.agentCli as AgentCli | undefined;
    const defaultIndex = existingAgent && installed.includes(existingAgent) ? installed.indexOf(existingAgent) : 0;
    const agentCli =
      flags.agentCli ??
      (installed.length === 1
        ? installed[0]!
        : await askChoice(
            asker,
            'Which agent CLI should loop use by default?',
            installed.map((cli) => ({ label: cli, value: cli })),
            defaultIndex,
          ));

    // Discovery: a bounded throwaway session that learns the repo. Best-effort —
    // any failure just means the questions fall back to plain defaults.
    let discovered: DiscoveryReport = { verifyCmd: null, issuesDir: null, specsDir: null };
    if (!flags.noDiscovery) {
      console.log(`[loop] running a discovery session on ${agentCli} (bounded at 15m) — it inspects, never edits…`);
      try {
        const result = await runAgent(DISCOVERY_PROMPT, {
          config: {
            ...DEFAULT_CONFIG,
            agentCli,
            agentTimeoutMs: DISCOVERY_WALL_MS,
            agentIdleTimeoutMs: DISCOVERY_IDLE_MS,
          },
          stage: 'implement',
          cwd: resolveRoot(),
          logPath: path.join(resolveRoot(), '.loop', 'init', 'discovery.stream.log'),
          stageLabel: 'init-discovery',
          liveOutput: !flags.quiet,
        });
        if (result.ok) {
          discovered = parseDiscoveryReport(extractAgentResultText(result));
          console.log(
            `[loop] discovery: verify=${discovered.verifyCmd ?? 'none'}, issues-dir=${discovered.issuesDir ?? 'none'}, specs-dir=${discovered.specsDir ?? 'none'}`,
          );
        } else {
          console.warn('[loop] discovery session failed — continuing with plain defaults.');
        }
      } catch (error) {
        console.warn(`[loop] discovery session error (${String(error)}) — continuing with plain defaults.`);
      }
    }

    const existingVerify = existing.verifyCmd as string | undefined;
    let verifyCmd: string | null = null;
    if (existingVerify === undefined) {
      verifyCmd = flags.verifyCmd ?? await askVerifyCommand(asker, discovered.verifyCmd ?? undefined);
    }

    const planning = await gatherPlanningAnswers(resolveRoot(), asker, flags, existing, discovered);
    return { agentCli, verifyCmd, ...planning, project: null };
  } finally {
    asker.close();
  }
}
