/**
 * Per-stage agent/model/effort resolution, evaluated independently for `agentCli`,
 * `model`, and `effort` (a stage can override just one of the three):
 *
 *   CLI flag (whole-run override, beats every stage)
 *   > stages.<stage>.agentCli/model/effort in config
 *   > projects.<name>.model/effort in config
 *   > top-level agentCli/model/effort in config
 *   > built-in default (already folded into LoopConfig)
 *
 * A project's model/effort replace the cross-cutting defaults but **lose to a
 * per-stage entry**: `stages.<stage>` states something about a *kind of work*
 * that holds across projects, so a project default must not silently undo it.
 *
 * There is deliberately no per-project `agentCli`: the startup check that every
 * needed CLI is present runs before any project is known, so a per-project
 * agent could slip past it and fail mid-backlog.
 *
 * There is deliberately no stage-to-stage inheritance either: an omitted stage
 * field falls straight back to the next layer, so each stage's effective
 * settings can be read off directly.
 */

import type { AgentCli, LoopConfig, StageName } from './types.js';

export type StageAgentSettings = { agentCli: AgentCli; model: string; effort: string | null };

/** The raw `--agent-cli` / `--model` / `--effort` CLI flags, if given. */
export type StageCliFlags = {
  agentCli?: AgentCli | undefined;
  model?: string | undefined;
  effort?: string | undefined;
};

export function resolveStageAgentSettings(
  config: LoopConfig,
  cliFlags: StageCliFlags,
  stage: StageName,
  project?: string,
): StageAgentSettings {
  const stageOverride = config.stages[stage];
  const projectOverride = project ? config.projects[project] : undefined;
  return {
    agentCli: cliFlags.agentCli ?? stageOverride?.agentCli ?? config.agentCli,
    model: cliFlags.model ?? stageOverride?.model ?? projectOverride?.model ?? config.model,
    effort: cliFlags.effort ?? stageOverride?.effort ?? projectOverride?.effort ?? config.effort,
  };
}

/**
 * The provider chain for one stage. Fallback model/effort values deliberately
 * default to the fallback CLI's own defaults instead of inheriting potentially
 * incompatible primary settings. A CLI appears at most once in the chain.
 */
export function resolveStageAgentCandidates(
  config: LoopConfig,
  cliFlags: StageCliFlags,
  stage: StageName,
  project?: string,
): StageAgentSettings[] {
  const primary = resolveStageAgentSettings(config, cliFlags, stage, project);
  const seen = new Set<AgentCli>([primary.agentCli]);
  const candidates = [primary];

  for (const fallback of config.fallbackAgents) {
    if (seen.has(fallback.agentCli)) continue;
    seen.add(fallback.agentCli);
    candidates.push({
      agentCli: fallback.agentCli,
      model: fallback.model ?? 'auto',
      effort: fallback.effort ?? null,
    });
  }
  return candidates;
}
