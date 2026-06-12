/**
 * Zero-cost integration path: mixed-stage config → per-stage settings →
 * provider buildArgs + startup binary availability, without spawning real CLIs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkAgentBinaries } from '../commands/startup.js';
import { DEFAULT_CONFIG } from '../config/load-config.js';
import { resolveStageAgentSettings } from '../config/stage-settings.js';
import type { LoopConfig, StageName } from '../config/types.js';
import { resolveAgentProvider } from './providers/index.js';

const shellMock = vi.fn<(command: string, cwd?: string) => { ok: boolean; output: string; code: number | null }>();
const failStopMock = vi.fn<(reason: string, options?: { code?: number; details?: string[] }) => never>();

vi.mock('../shared/shell.js', () => ({
  shell: (command: string, cwd?: string) => shellMock(command, cwd),
}));

vi.mock('../interrupt/shutdown.js', () => ({
  failStop: (reason: string, options?: { code?: number; details?: string[] }) => failStopMock(reason, options),
}));

const MIXED_STAGE_CONFIG: LoopConfig = {
  ...DEFAULT_CONFIG,
  agentCli: 'cursor',
  model: 'auto',
  stages: {
    implement: { agentCli: 'claude-code', model: 'sonnet-5', effort: 'high' },
    verifyFix: { agentCli: 'cursor' },
    review: { agentCli: 'codex', model: 'gpt-5.5', effort: 'medium' },
    reviewFix: { agentCli: 'claude-code', model: 'sonnet-5' },
  },
};

const STAGES: StageName[] = ['implement', 'verifyFix', 'review', 'reviewFix'];

beforeEach(() => {
  shellMock.mockReset();
  failStopMock.mockReset();
  failStopMock.mockImplementation((reason) => {
    throw new Error(`failStop: ${reason}`);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('mixed-stage provider integration (no real CLI spawn)', () => {
  it('resolves distinct providers and buildArgs per stage from one config', () => {
    const buildInput = { prompt: 'do work', model: null as string | null, effort: null as string | null, cwd: '/tmp/work' };
    const byStage = Object.fromEntries(
      STAGES.map((stage) => {
        const settings = resolveStageAgentSettings(MIXED_STAGE_CONFIG, {}, stage);
        const provider = resolveAgentProvider(settings.agentCli);
        return [
          stage,
          {
            agentCli: settings.agentCli,
            model: settings.model,
            binaryName: provider.binaryName,
            args: provider.buildArgs({ ...buildInput, model: settings.model, effort: settings.effort }),
          },
        ];
      }),
    );

    expect(byStage.implement).toEqual({
      agentCli: 'claude-code',
      model: 'sonnet-5',
      binaryName: 'claude',
      args: expect.arrayContaining(['-p', '--model', 'sonnet-5', '--effort', 'high', 'do work']),
    });
    expect(byStage.verifyFix).toEqual({
      agentCli: 'cursor',
      model: 'auto',
      binaryName: 'cursor',
      args: expect.arrayContaining(['agent', '-p', '--workspace', '/tmp/work', 'do work']),
    });
    expect(byStage.review).toEqual({
      agentCli: 'codex',
      model: 'gpt-5.5',
      binaryName: 'codex',
      args: expect.arrayContaining(['exec', 'do work', '--json', '-m', 'gpt-5.5', 'model_reasoning_effort="medium"']),
    });
    expect(byStage.reviewFix).toEqual({
      agentCli: 'claude-code',
      model: 'sonnet-5',
      binaryName: 'claude',
      args: expect.arrayContaining(['-p', '--model', 'sonnet-5', 'do work']),
    });

    const distinctBinaries = new Set(STAGES.map((stage) => byStage[stage]!.binaryName));
    expect([...distinctBinaries].sort()).toEqual(['claude', 'codex', 'cursor']);
  });

  it('checkAgentBinaries requires all three binaries for the mixed config', () => {
    shellMock.mockImplementation((command) => {
      const binary = command.match(/^command -v (\S+)$/)?.[1];
      return { ok: binary === 'cursor', output: '', code: binary === 'cursor' ? 0 : 1 };
    });

    expect(() => checkAgentBinaries(MIXED_STAGE_CONFIG, {}, STAGES)).toThrow(/failStop/);
    expect(failStopMock.mock.calls[0]?.[1]?.details).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/`claude` not found on PATH — needed by stage\(s\): implement, reviewFix/),
        expect.stringMatching(/`codex` not found on PATH — needed by stage\(s\): review/),
      ]),
    );
  });

  it('passes the availability check when cursor, claude, and codex are on PATH', () => {
    shellMock.mockImplementation((command) => {
      const binary = command.match(/^command -v (\S+)$/)?.[1];
      const present = binary === 'cursor' || binary === 'claude' || binary === 'codex';
      return { ok: present, output: '', code: present ? 0 : 1 };
    });

    expect(() => checkAgentBinaries(MIXED_STAGE_CONFIG, {}, STAGES)).not.toThrow();
    expect(shellMock.mock.calls.map(([command]) => command).sort()).toEqual([
      'command -v claude',
      'command -v codex',
      'command -v cursor',
    ]);
  });
});
