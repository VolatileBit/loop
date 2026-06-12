import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../config/load-config.js';
import type { LoopConfig } from '../config/types.js';
import { checkAgentBinaries, warnIfAgentBinariesNotAuthenticated, warnIfAgentBinariesNotRunnable } from './startup.js';
import * as agentAuthProbe from './agent-auth-probe.js';

const shellMock = vi.fn<(command: string, cwd?: string) => { ok: boolean; output: string; code: number | null }>();
const failStopMock = vi.fn<(reason: string, options?: { code?: number; details?: string[] }) => never>();
const spawnSyncMock = vi.hoisted(() =>
  vi.fn<
    (command: string, args: string[], options: { timeout?: number }) => {
      status: number | null;
      stdout: string;
      stderr: string;
      error?: Error;
    }
  >(),
);

vi.mock('../shared/shell.js', () => ({
  shell: (command: string, cwd?: string) => shellMock(command, cwd),
}));

vi.mock('../interrupt/shutdown.js', () => ({
  failStop: (reason: string, options?: { code?: number; details?: string[] }) => failStopMock(reason, options),
}));

vi.mock('node:child_process', () => ({
  spawnSync: (command: string, args: string[], options: { timeout?: number }) =>
    spawnSyncMock(command, args, options),
}));

function config(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function binariesOnPath(...names: string[]): void {
  shellMock.mockImplementation((command) => {
    const match = command.match(/^command -v (\S+)$/);
    const binary = match?.[1];
    return { ok: binary !== undefined && names.includes(binary), output: '', code: binary && names.includes(binary) ? 0 : 1 };
  });
}

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

describe('checkAgentBinaries', () => {
  it('passes when every distinct binary resolved across stages is on PATH', () => {
    binariesOnPath('cursor', 'claude', 'codex');
    const cfg = config({
      agentCli: 'cursor',
      model: 'auto',
      stages: {
        implement: { agentCli: 'claude-code', model: 'sonnet-5' },
        verifyFix: { agentCli: 'cursor' },
        review: { agentCli: 'codex', model: 'gpt-5.5' },
      },
    });

    expect(() => checkAgentBinaries(cfg, {}, ['implement', 'verifyFix', 'review'])).not.toThrow();

    const checked = shellMock.mock.calls.map(([command]) => command).sort();
    expect(checked).toEqual(['command -v claude', 'command -v codex', 'command -v cursor']);
  });

  it('deduplicates binaries shared by multiple stages', () => {
    binariesOnPath('cursor');
    const cfg = config({
      agentCli: 'cursor',
      stages: { implement: { agentCli: 'cursor' }, review: { agentCli: 'cursor' } },
    });

    expect(() => checkAgentBinaries(cfg, {}, ['implement', 'review'])).not.toThrow();
    expect(shellMock).toHaveBeenCalledTimes(1);
    expect(shellMock).toHaveBeenCalledWith('command -v cursor', undefined);
  });

  it('failStops naming each missing binary and the stage(s) that need it', () => {
    binariesOnPath('cursor');
    const cfg = config({
      agentCli: 'cursor',
      stages: {
        implement: { agentCli: 'claude-code' },
        verifyFix: { agentCli: 'cursor' },
        review: { agentCli: 'codex' },
        reviewFix: { agentCli: 'claude-code' },
      },
    });

    expect(() => checkAgentBinaries(cfg, {}, ['implement', 'verifyFix', 'review', 'reviewFix'])).toThrow(
      /failStop: agent CLI binary missing/,
    );

    expect(failStopMock).toHaveBeenCalledWith('agent CLI binary missing', {
      details: expect.arrayContaining([
        expect.stringMatching(/`claude` not found on PATH — needed by stage\(s\): implement, reviewFix/),
        expect.stringMatching(/`codex` not found on PATH — needed by stage\(s\): review/),
      ]),
    });
  });

  it('CLI flags override stage config before resolving binaries', () => {
    binariesOnPath('codex');
    const cfg = config({
      stages: {
        implement: { agentCli: 'claude-code' },
        review: { agentCli: 'cursor' },
      },
    });

    expect(() => checkAgentBinaries(cfg, { agentCli: 'codex' }, ['implement', 'review'])).not.toThrow();
    expect(shellMock).toHaveBeenCalledTimes(1);
    expect(shellMock).toHaveBeenCalledWith('command -v codex', undefined);
  });

  it('only checks binaries for the stages the command will run', () => {
    binariesOnPath('cursor');
    const cfg = config({ stages: { review: { agentCli: 'codex' } } });

    expect(() => checkAgentBinaries(cfg, {}, ['implement'])).not.toThrow();
    expect(shellMock).toHaveBeenCalledTimes(1);
    expect(shellMock).toHaveBeenCalledWith('command -v cursor', undefined);
  });

  it('checks every configured fallback binary for an active stage', () => {
    binariesOnPath('codex', 'claude', 'copilot');
    const cfg = config({
      agentCli: 'codex',
      fallbackAgents: [
        { agentCli: 'claude-code' },
        { agentCli: 'copilot' },
      ],
    });

    expect(() => checkAgentBinaries(cfg, {}, ['implement'])).not.toThrow();
    expect(shellMock.mock.calls.map(([command]) => command).sort()).toEqual([
      'command -v claude',
      'command -v codex',
      'command -v copilot',
    ]);
  });
});

describe('warnIfAgentBinariesNotRunnable', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns when a binary is on PATH but --version fails', () => {
    spawnSyncMock.mockImplementation((command) => ({
      status: command === 'cursor' ? 0 : 1,
      stdout: '',
      stderr: command === 'codex' ? 'not logged in' : '',
    }));

    const cfg = config({
      agentCli: 'cursor',
      stages: { review: { agentCli: 'codex' } },
    });

    warnIfAgentBinariesNotRunnable(cfg, {}, ['implement', 'review']);
    expect(spawnSyncMock).toHaveBeenCalledWith('cursor', ['--version'], expect.objectContaining({ timeout: 5000 }));
    expect(spawnSyncMock).toHaveBeenCalledWith('codex', ['--version'], expect.objectContaining({ timeout: 5000 }));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/warning: `codex --version` failed/));
  });

  it('stays silent when every probed binary responds to --version', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '1.0.0', stderr: '' });
    const cfg = config({ agentCli: 'cursor' });

    warnIfAgentBinariesNotRunnable(cfg, {}, ['implement']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('probes fallback binaries as well as the primary binary', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '1.0.0', stderr: '' });
    const cfg = config({
      agentCli: 'codex',
      fallbackAgents: [{ agentCli: 'claude-code' }],
    });

    warnIfAgentBinariesNotRunnable(cfg, {}, ['implement']);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'codex',
      ['--version'],
      expect.objectContaining({ timeout: 5000 }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'claude',
      ['--version'],
      expect.objectContaining({ timeout: 5000 }),
    );
  });
});

describe('warnIfAgentBinariesNotAuthenticated', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let probeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    probeSpy = vi.spyOn(agentAuthProbe, 'probeAgentAuth');
  });

  afterEach(() => {
    warnSpy.mockRestore();
    probeSpy.mockRestore();
  });

  it('warns when an auth probe reports failure', () => {
    probeSpy.mockImplementation((_binary: string) => {
      if (_binary === 'codex') return { ok: false as const, reason: 'Not logged in' };
      return { ok: true as const };
    });

    const cfg = config({
      agentCli: 'cursor',
      stages: { review: { agentCli: 'codex' } },
    });

    warnIfAgentBinariesNotAuthenticated(cfg, {}, ['implement', 'review']);
    expect(probeSpy).toHaveBeenCalledWith('cursor', agentAuthProbe.AGENT_AUTH_PROBE.cursor);
    expect(probeSpy).toHaveBeenCalledWith('codex', agentAuthProbe.AGENT_AUTH_PROBE.codex);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/warning: `codex login status` suggests the CLI is not authenticated/),
    );
  });

  it('stays silent when every auth probe passes', () => {
    probeSpy.mockReturnValue({ ok: true });
    const cfg = config({ agentCli: 'cursor' });

    warnIfAgentBinariesNotAuthenticated(cfg, {}, ['implement']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('probes fallback authentication as well as the primary agent', () => {
    probeSpy.mockReturnValue({ ok: true });
    const cfg = config({
      agentCli: 'codex',
      fallbackAgents: [{ agentCli: 'claude-code' }],
    });

    warnIfAgentBinariesNotAuthenticated(cfg, {}, ['implement']);
    expect(probeSpy).toHaveBeenCalledWith(
      'codex',
      agentAuthProbe.AGENT_AUTH_PROBE.codex,
    );
    expect(probeSpy).toHaveBeenCalledWith(
      'claude',
      agentAuthProbe.AGENT_AUTH_PROBE['claude-code'],
    );
  });
});
