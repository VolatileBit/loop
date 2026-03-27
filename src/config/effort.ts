/**
 * Provider-specific effort / reasoning-intensity levels. Values are taken from
 * each CLI's documented flags:
 *
 * - Claude Code: `claude -p --effort <level>` (claude --help)
 * - Codex: `codex exec -c model_reasoning_effort="<level>"` (~/.codex/config.toml)
 *
 * Cursor has no equivalent — effort configured for a cursor stage is rejected
 * at startup (see collectStageEffortErrors).
 */

import type { AgentCli, StageName } from './types.js';
import type { LoopConfig } from './types.js';
import { resolveStageAgentCandidates, type StageCliFlags } from './stage-settings.js';

/** Claude Code `--effort` values (claude --help). */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Codex `model_reasoning_effort` values (config.toml / openai/codex ReasoningEffort). */
export const CODEX_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

/** Copilot `--effort/--reasoning-effort` values (copilot --help, 1.0.71). */
export const COPILOT_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Union for shell completion (`--effort` candidates). */
export const EFFORT_LEVELS = [
  ...new Set([...CLAUDE_EFFORT_LEVELS, ...CODEX_EFFORT_LEVELS]),
];

export function allowedEffortLevels(agentCli: AgentCli): readonly string[] | null {
  switch (agentCli) {
    case 'claude-code':
      return CLAUDE_EFFORT_LEVELS;
    case 'codex':
      return CODEX_EFFORT_LEVELS;
    case 'copilot':
      return COPILOT_EFFORT_LEVELS;
    case 'cursor':
      return null;
  }
}

/** Returns a human-readable error, or null when effort is valid for the agent. */
export function validateEffortForAgent(agentCli: AgentCli, effort: string): string | null {
  if (agentCli === 'cursor') {
    return 'effort is not supported by the cursor agent CLI — remove effort from config or change agentCli';
  }
  const allowed = allowedEffortLevels(agentCli);
  if (allowed && !(allowed as readonly string[]).includes(effort)) {
    return `effort "${effort}" is not valid for ${agentCli} (allowed: ${allowed.join(', ')})`;
  }
  return null;
}

/**
 * Collect effort validation errors for the stages a command will run — for the
 * cross-cutting settings and for every configured project, so an invalid
 * pairing fails at startup naming the project, rather than mid-backlog when
 * that project's first issue is claimed.
 */
export function collectStageEffortErrors(
  config: LoopConfig,
  cliFlags: StageCliFlags,
  stages: readonly StageName[],
): string[] {
  const errors: string[] = [];
  const projects: (string | undefined)[] = [undefined, ...Object.keys(config.projects)];

  for (const project of projects) {
    // A project without its own effort resolves identically to the global
    // settings; reporting the same error twice helps nobody.
    if (project !== undefined && config.projects[project]?.effort === undefined) continue;

    for (const stage of stages) {
      for (const [index, settings] of resolveStageAgentCandidates(
        config,
        cliFlags,
        stage,
        project,
      ).entries()) {
        if (settings.effort === null) continue;
        const message = validateEffortForAgent(settings.agentCli, settings.effort);
        if (!message) continue;
        const candidate = index === 0 ? '' : ` fallback "${settings.agentCli}"`;
        const scope = project === undefined ? '' : ` in project "${project}"`;
        errors.push(`Stage "${stage}"${candidate}${scope}: ${message}.`);
      }
    }
  }
  return errors;
}
