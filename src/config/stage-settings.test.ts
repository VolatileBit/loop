import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from './load-config.js';
import { resolveStageAgentCandidates, resolveStageAgentSettings } from './stage-settings.js';
import type { LoopConfig } from './types.js';

function config(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe('resolveStageAgentSettings', () => {
  it('falls back to built-in defaults when nothing is configured', () => {
    expect(resolveStageAgentSettings(config(), {}, 'implement')).toEqual({
      agentCli: 'cursor',
      model: 'auto',
      effort: null,
    });
  });

  it('uses top-level config values for stages without overrides', () => {
    const cfg = config({ agentCli: 'claude-code', model: 'sonnet-5' });
    for (const stage of ['implement', 'verifyFix', 'review', 'reviewFix'] as const) {
      expect(resolveStageAgentSettings(cfg, {}, stage)).toEqual({
        agentCli: 'claude-code',
        model: 'sonnet-5',
        effort: null,
      });
    }
  });

  it('applies per-stage overrides only to their own stage (no stage-to-stage inheritance)', () => {
    const cfg = config({
      agentCli: 'cursor',
      model: 'auto',
      stages: {
        implement: { agentCli: 'claude-code', model: 'sonnet-5' },
        review: { agentCli: 'codex', model: 'gpt-5.5' },
      },
    });

    expect(resolveStageAgentSettings(cfg, {}, 'implement')).toEqual({
      agentCli: 'claude-code',
      model: 'sonnet-5',
      effort: null,
    });
    expect(resolveStageAgentSettings(cfg, {}, 'review')).toEqual({
      agentCli: 'codex',
      model: 'gpt-5.5',
      effort: null,
    });
    // verifyFix has no override — falls back to top-level, not to implement's values.
    expect(resolveStageAgentSettings(cfg, {}, 'verifyFix')).toEqual({
      agentCli: 'cursor',
      model: 'auto',
      effort: null,
    });
    expect(resolveStageAgentSettings(cfg, {}, 'reviewFix')).toEqual({
      agentCli: 'cursor',
      model: 'auto',
      effort: null,
    });
  });

  it('resolves agentCli and model independently (a stage can override just one)', () => {
    const cfg = config({
      agentCli: 'cursor',
      model: 'auto',
      stages: { verifyFix: { agentCli: 'claude-code' }, review: { model: 'gpt-5.5' } },
    });

    expect(resolveStageAgentSettings(cfg, {}, 'verifyFix')).toEqual({
      agentCli: 'claude-code',
      model: 'auto',
      effort: null,
    });
    expect(resolveStageAgentSettings(cfg, {}, 'review')).toEqual({
      agentCli: 'cursor',
      model: 'gpt-5.5',
      effort: null,
    });
  });

  it('CLI flags override every stage, including per-stage config overrides', () => {
    const cfg = config({
      agentCli: 'cursor',
      model: 'auto',
      stages: { implement: { agentCli: 'claude-code', model: 'sonnet-5' } },
    });

    expect(resolveStageAgentSettings(cfg, { agentCli: 'codex', model: 'gpt-5.5' }, 'implement')).toEqual({
      agentCli: 'codex',
      model: 'gpt-5.5',
      effort: null,
    });
    expect(resolveStageAgentSettings(cfg, { agentCli: 'codex', model: 'gpt-5.5' }, 'review')).toEqual({
      agentCli: 'codex',
      model: 'gpt-5.5',
      effort: null,
    });
  });

  it('a lone --model flag overrides models but leaves agentCli resolution alone', () => {
    const cfg = config({
      stages: { review: { agentCli: 'codex', model: 'gpt-5.5' } },
    });

    expect(resolveStageAgentSettings(cfg, { model: 'flag-model' }, 'review')).toEqual({
      agentCli: 'codex',
      model: 'flag-model',
      effort: null,
    });
  });

  it('resolves effort independently with the same precedence as model', () => {
    const cfg = config({
      effort: 'medium',
      stages: {
        implement: { effort: 'high' },
        review: { agentCli: 'codex', effort: 'xhigh' },
      },
    });

    expect(resolveStageAgentSettings(cfg, {}, 'implement')).toEqual({
      agentCli: 'cursor',
      model: 'auto',
      effort: 'high',
    });
    expect(resolveStageAgentSettings(cfg, {}, 'review')).toEqual({
      agentCli: 'codex',
      model: 'auto',
      effort: 'xhigh',
    });
    expect(resolveStageAgentSettings(cfg, { effort: 'low' }, 'reviewFix')).toEqual({
      agentCli: 'cursor',
      model: 'auto',
      effort: 'low',
    });
  });
});

describe('resolveStageAgentCandidates', () => {
  it('returns the resolved primary followed by configured fallbacks', () => {
    const cfg = config({
      agentCli: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      fallbackAgents: [
        { agentCli: 'claude-code', model: 'opus-5', effort: 'high' },
        { agentCli: 'copilot' },
      ],
    });

    expect(resolveStageAgentCandidates(cfg, {}, 'implement')).toEqual([
      { agentCli: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
      { agentCli: 'claude-code', model: 'opus-5', effort: 'high' },
      { agentCli: 'copilot', model: 'auto', effort: null },
    ]);
  });

  it('does not retry a fallback CLI that is already the resolved primary', () => {
    const cfg = config({
      agentCli: 'codex',
      fallbackAgents: [
        { agentCli: 'codex', model: 'another-codex-model' },
        { agentCli: 'copilot' },
      ],
    });

    expect(resolveStageAgentCandidates(cfg, {}, 'review').map((entry) => entry.agentCli)).toEqual([
      'codex',
      'copilot',
    ]);
  });

  it('applies whole-run CLI flags only to the primary candidate', () => {
    const cfg = config({
      stages: { review: { agentCli: 'codex', model: 'stage-model', effort: 'high' } },
      fallbackAgents: [{ agentCli: 'claude-code', model: 'fallback-model', effort: 'medium' }],
    });

    expect(
      resolveStageAgentCandidates(
        cfg,
        { agentCli: 'copilot', model: 'flag-model', effort: 'xhigh' },
        'review',
      ),
    ).toEqual([
      { agentCli: 'copilot', model: 'flag-model', effort: 'xhigh' },
      { agentCli: 'claude-code', model: 'fallback-model', effort: 'medium' },
    ]);
  });
});

describe('per-project model and effort', () => {
  const config = (): LoopConfig => ({
    ...DEFAULT_CONFIG,
    agentCli: 'claude-code',
    model: 'sonnet-5',
    effort: 'medium',
    stages: { review: { model: 'opus-5' } },
    projects: {
      web: { model: 'haiku-4-5', effort: 'low' },
      docs: {},
    },
  });

  it("applies a project's model where no stage entry claims it", () => {
    expect(resolveStageAgentSettings(config(), {}, 'implement', 'web')).toMatchObject({
      model: 'haiku-4-5',
      effort: 'low',
    });
  });

  it('loses to a per-stage entry, which states something about a kind of work', () => {
    // stages.review.model holds across projects; a project default must not undo it.
    expect(resolveStageAgentSettings(config(), {}, 'review', 'web').model).toBe('opus-5');
    // But the project's effort still applies — the stage entry claims only model.
    expect(resolveStageAgentSettings(config(), {}, 'review', 'web').effort).toBe('low');
  });

  it('falls back to the global settings for projects without an override', () => {
    expect(resolveStageAgentSettings(config(), {}, 'implement', 'docs')).toMatchObject({
      model: 'sonnet-5',
      effort: 'medium',
    });
    expect(resolveStageAgentSettings(config(), {}, 'implement', 'unlisted').model).toBe('sonnet-5');
  });

  it('still loses to a whole-run CLI flag', () => {
    expect(resolveStageAgentSettings(config(), { model: 'flagged' }, 'implement', 'web').model).toBe('flagged');
  });

  it('never changes the agent CLI — the startup binary check runs before a project is known', () => {
    expect(resolveStageAgentSettings(config(), {}, 'implement', 'web').agentCli).toBe('claude-code');
  });
});
