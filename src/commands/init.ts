
import path from 'node:path';

import { runAgent, extractAgentResultText } from '../agent/run-agent.js';
import { askChoice, askWithDefault, askYesNo, createAsker, type Asker } from '../cli/ask.js';
import type { InitFlags } from '../cli/args.js';
import { DEFAULT_CONFIG } from '../config/load-config.js';
import { type AgentCli } from '../config/types.js';
import { failStop } from '../interrupt/shutdown.js';
import { resolveRoot } from '../shared/paths.js';
import { shell } from '../shared/shell.js';

export const LOOP_DISCOVERY_HEADING = '## Loop discovery';

export type DiscoveryReport = {
  verifyCmd: string | null;
  issuesDir: string | null;
  prdsDir: string | null;
};

/**
 * Parse the discovery session's report block:
 *
 *   ## Loop discovery
 *   verify: <command or none>
 *   issues-dir: <dir or none>
 *   prds-dir: <dir or none>
 *
 * Absent/`none` fields resolve to null; a missing block resolves to an empty
 * report (discovery is best-effort — init just falls back to plain defaults).
 */
export function parseDiscoveryReport(text: string): DiscoveryReport {
  const empty: DiscoveryReport = { verifyCmd: null, issuesDir: null, prdsDir: null };
  const match = text.match(/## Loop discovery\s*\n([\s\S]*?)(?:\n## |$)/i);
  if (!match) return empty;
  const block = match[1] ?? '';

  const field = (name: string): string | null => {
    const value = block.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1]?.trim() ?? null;
    if (!value || value.toLowerCase() === 'none') return null;
    return value;
  };

  return { verifyCmd: field('verify'), issuesDir: field('issues-dir'), prdsDir: field('prds-dir') };
}

/** The subset of loop.config.json that init may write. */
export type InitAnswers = {
  agentCli: AgentCli;
  verifyCmd: string | null;
  issuesDir: string | null;
  prdsDir: string | null;
  project: { name: string; verifyCmd?: string; prd?: string } | null;
};

const DISCOVERY_PROMPT = [
  'Inspect this repository to help set up an autonomous issue-runner. **Read-only**: do not create, modify, or delete anything, and do not run package installs.',
  '',
  'Find:',
  '1. The single shell command that best verifies the repo (typecheck + tests, e.g. `pnpm verify`, `npm test`, `cargo test`). Prefer what package.json scripts / Makefile / CI configs actually use. Run it if it is safe and fast enough to confirm it executes.',
  '2. Where markdown issues/tasks live, if such a directory exists.',
  '3. Where PRD/spec/feature documents live, if such a directory exists.',
  '',
  'End your final response with **exactly** this block (use `none` when the repo has no answer):',
  '',
  LOOP_DISCOVERY_HEADING,
  'verify: <command or none>',
  'issues-dir: <repo-relative dir or none>',
  'prds-dir: <repo-relative dir or none>',
].join('\n');

/** Discovery session timeouts — a repo survey must not get 2 hours. */
const DISCOVERY_WALL_MS = 15 * 60 * 1000;
const DISCOVERY_IDLE_MS = 5 * 60 * 1000;

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
    issuesDir: flags.issuesDir ?? null,
    prdsDir: flags.prdsDir ?? null,
    project: flags.project
      ? {
          name: flags.project,
          ...(flags.projectVerifyCmd ? { verifyCmd: flags.projectVerifyCmd } : {}),
          ...(flags.projectPrd ? { prd: flags.projectPrd } : {}),
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
    let discovered: DiscoveryReport = { verifyCmd: null, issuesDir: null, prdsDir: null };
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
            `[loop] discovery: verify=${discovered.verifyCmd ?? 'none'}, issues-dir=${discovered.issuesDir ?? 'none'}, prds-dir=${discovered.prdsDir ?? 'none'}`,
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
      verifyCmd = await askVerifyCommand(asker, discovered.verifyCmd ?? undefined);
    }

    const issuesDir =
      existing.issuesDir !== undefined
        ? null
        : await askWithDefault(asker, 'Issues directory', discovered.issuesDir ?? 'issues');

    const prdsDirAnswer =
      existing.prdsDir !== undefined
        ? 'none'
        : await askWithDefault(asker, 'PRD/spec docs directory (or none)', discovered.prdsDir ?? 'none');

    // Asked as a real yes/no: the old free-text form ("name, or none") made
    // "no" a plausible answer, which would have been written as a project name.
    let project: InitAnswers['project'] = null;
    if (await askYesNo(asker, 'Add a projects.<name> override entry?', false)) {
      const projectName = await askWithDefault(asker, 'Project folder name (under the issues directory)');
      const projectVerify = await askWithDefault(
        asker,
        `Verify command for ${projectName} (or "none" to use the global one)`,
        'none',
      );
      const projectPrd = await askWithDefault(
        asker,
        `PRD path or filename prefix for ${projectName} (or "none")`,
        'none',
      );
      project = {
        name: projectName,
        ...(projectVerify.toLowerCase() !== 'none' ? { verifyCmd: projectVerify } : {}),
        ...(projectPrd.toLowerCase() !== 'none' ? { prd: projectPrd } : {}),
      };
    }

    return {
      agentCli,
      verifyCmd,
      issuesDir,
      prdsDir: prdsDirAnswer.toLowerCase() === 'none' ? null : prdsDirAnswer,
      project,
    };
  } finally {
    asker.close();
  }
}
