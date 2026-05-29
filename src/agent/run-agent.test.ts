import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../config/load-config.js';
import type { AgentCli, LoopConfig } from '../config/types.js';
import { AgentAvailabilityTracker } from './provider-availability.js';
import { isSharedInfraError } from './providers/infra-error.js';
import { isSharedUsageLimitError } from './providers/usage-limit.js';
import { runAgent } from './run-agent.js';
import type { AgentProvider, CanonicalAgentEvent } from './providers/types.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'loop-run-agent-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/**
 * A provider whose "binary" is the node executable and whose "prompt" is a JS
 * script — lets us exercise the real spawn/stream/timeout machinery without
 * any agent CLI.
 */
function fakeProvider(): AgentProvider {
  return {
    id: 'cursor',
    binaryName: process.execPath,
    buildArgs: ({ prompt }) => ['-e', prompt],
    parseLine: (line): CanonicalAgentEvent | null => {
      try {
        const event = JSON.parse(line) as {
          type?: string;
          is_error?: boolean;
          result?: string;
          text?: string;
          durationMs?: number;
        };
        if (event.type === 'result') {
          return {
            type: 'result',
            ok: event.is_error !== true,
            durationMs: event.durationMs ?? 0,
            text: event.result ?? null,
          };
        }
        if (event.type === 'session') return { type: 'session-start', model: '' };
        if (event.type === 'text') return { type: 'assistant-text', text: event.text ?? '', consolidated: true };
        return null;
      } catch {
        return { type: 'raw-line', text: line };
      }
    },
    buildResumeArgs: ({ prompt, sessionId }) => ['-e', `/*resume:${sessionId}*/${prompt}`],
    extractSessionId: (output) => output.match(/"session_id":"([^"]+)"/)?.[1] ?? null,
    extractResultText: (output) => output,
    extractUsage: () => ({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
    extractCostUsd: () => null,
    isUsageLimitError: isSharedUsageLimitError,
    isInfraError: isSharedInfraError,
    // Per-request context, mirroring claude-code's `assistant` events.
    parseTurnContextTokens: (line) => {
      try {
        const event = JSON.parse(line) as { type?: string; contextTokens?: number };
        return event.type === 'turn' && typeof event.contextTokens === 'number' ? event.contextTokens : null;
      } catch {
        return null;
      }
    },
  };
}

function fakeProviderFor(agentCli: AgentCli, scriptOverride?: string): AgentProvider {
  const provider = fakeProvider();
  return {
    ...provider,
    id: agentCli,
    buildArgs: ({ prompt }) => ['-e', scriptOverride ?? prompt],
  };
}

function config(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    ...DEFAULT_CONFIG,
    // Generous headroom on purpose: these tests spawn real node subprocesses,
    // and under full-suite contention a spawn can take seconds. A tight idle
    // timeout turns an intended usage-limit failure into a `stuck` one and
    // fails assertions that have nothing to do with timeouts. The one test
    // that *does* exercise the idle timeout sets its own 300ms.
    agentTimeoutMs: 120_000,
    agentIdleTimeoutMs: 60_000,
    heartbeatIntervalMs: 1_000,
    // Retrying is opt-in per test: the default policy's backoff would make
    // every ordinary-failure case here sit out 45 seconds of sleeping.
    agentRetries: { attempts: 0, initialDelayMs: 1, maxDelayMs: 1 },
    ...overrides,
  };
}

function baseOptions(dir: string) {
  return {
    config: config(),
    stage: 'implement' as const,
    cwd: dir,
    logPath: path.join(dir, 'runs', 'agent.stream.log'),
    stageLabel: 'PRD-006/issue-07-implement',
    liveOutput: false,
    provider: fakeProvider(),
    availability: new AgentAvailabilityTracker(() => Date.now()),
    shuttingDown: () => false,
  };
}

describe('runAgent', () => {
  it('returns ok with usage and writes the stream log on success', async () => {
    const dir = tempDir();
    const script = `console.log(JSON.stringify({ type: 'text', text: 'working' })); console.log(JSON.stringify({ type: 'result', result: 'all done' }));`;

    let spawnedPid: number | undefined;
    const result = await runAgent(script, {
      ...baseOptions(dir),
      onSpawn: (child) => {
        spawnedPid = child.pid;
      },
    });

    expect(result.ok).toBe(true);
    expect(result.stuckReason).toBeNull();
    expect(result.usageLimited).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
    expect(result.agentCli).toBe('cursor');
    expect(result.model).toBe('auto');
    expect(spawnedPid).toBeGreaterThan(0);
    expect(readFileSync(path.join(dir, 'runs', 'agent.stream.log'), 'utf8')).toContain('all done');
  });

  it('resolves per-stage model settings for the run', async () => {
    const dir = tempDir();
    const options = baseOptions(dir);
    const result = await runAgent(`console.log(JSON.stringify({ type: 'result', result: 'ok' }));`, {
      ...options,
      config: config({ stages: { implement: { model: 'sonnet-5' } } }),
    });
    expect(result.model).toBe('sonnet-5');
  });

  it('displays the resolved model when the provider session event omits it', async () => {
    const dir = tempDir();
    let output = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    try {
      await runAgent(
        `console.log(JSON.stringify({ type: 'session' })); console.log(JSON.stringify({ type: 'result', result: 'ok' }));`,
        {
          ...baseOptions(dir),
          config: config({ model: 'gpt-5.6-sol' }),
          liveOutput: true,
        },
      );
    } finally {
      writeSpy.mockRestore();
    }

    expect(output).toContain('[07|implement] │ session started (gpt-5.6-sol)');
  });

  it('does not display the auto sentinel as a concrete model', async () => {
    const dir = tempDir();
    let output = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    try {
      await runAgent(
        `console.log(JSON.stringify({ type: 'session' })); console.log(JSON.stringify({ type: 'result', result: 'ok' }));`,
        {
          ...baseOptions(dir),
          liveOutput: true,
        },
      );
    } finally {
      writeSpy.mockRestore();
    }

    expect(output).toContain('[07|implement] │ session started (unknown model)');
  });

  it('uses Loop elapsed time instead of the provider duration', async () => {
    const dir = tempDir();
    let output = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    try {
      await runAgent(
        `console.log(JSON.stringify({ type: 'session' })); setTimeout(() => console.log(JSON.stringify({ type: 'result', result: 'ok', durationMs: 86400000 })), 25);`,
        {
          ...baseOptions(dir),
          liveOutput: true,
        },
      );
    } finally {
      writeSpy.mockRestore();
    }

    expect(output).toMatch(/\[07\|implement] │ finished \((?!unknown duration\)).+\): ok/);
    expect(output).not.toContain('1d');
  });

  it('fails on a non-zero exit and detects usage-limit text on stderr', async () => {
    const dir = tempDir();
    const script = `console.error('rate limit exceeded'); process.exit(1);`;

    const result = await runAgent(script, baseOptions(dir));

    expect(result.ok).toBe(false);
    expect(result.stuckReason).toBeNull();
    expect(result.usageLimited).toBe(true);
  });

  it('fails when the terminal result event reports an error despite exit 0', async () => {
    const dir = tempDir();
    const script = `console.log(JSON.stringify({ type: 'result', is_error: true, result: 'model blew up' }));`;

    const result = await runAgent(script, baseOptions(dir));

    expect(result.ok).toBe(false);
    expect(result.stuckReason).toBeNull();
    expect(result.usageLimited).toBe(false);
  });

  it('kills an idle agent and reports idle-timeout', async () => {
    const dir = tempDir();
    const script = `setTimeout(() => {}, 60000);`; // no output, stays alive

    const result = await runAgent(script, {
      ...baseOptions(dir),
      config: config({ agentIdleTimeoutMs: 300, heartbeatIntervalMs: 100 }),
      liveOutput: true, // no heartbeat spam in test output
    });

    expect(result.ok).toBe(false);
    expect(result.stuckReason).toBe('idle-timeout');
  }, 15_000);

  it('reports interrupted when the process is shutting down as the child exits', async () => {
    const dir = tempDir();
    const script = `console.log(JSON.stringify({ type: 'result', result: 'fine' }));`;

    const result = await runAgent(script, { ...baseOptions(dir), shuttingDown: () => true });

    expect(result.ok).toBe(false);
    expect(result.stuckReason).toBe('interrupted');
    expect(result.output).toContain('interrupted by signal');
  });

  it('does not flag usage limit on successful output containing timestamp-like 429', async () => {
    const dir = tempDir();
    const script = `console.log(JSON.stringify({ type: 'text', text: 'elapsed 742934ms' })); console.log(JSON.stringify({ type: 'result', result: 'ok' }));`;

    const result = await runAgent(script, baseOptions(dir));

    expect(result.ok).toBe(true);
    expect(result.usageLimited).toBe(false);
  });

  it('detects usage limit in stderr when the process exits non-zero', async () => {
    const dir = tempDir();
    const script = `console.error('rate_limit_exceeded: quota'); process.exit(1);`;

    const result = await runAgent(script, baseOptions(dir));

    expect(result.ok).toBe(false);
    expect(result.usageLimited).toBe(true);
  });

  it('continues the same stage with the next fallback CLI after a usage limit', async () => {
    const dir = tempDir();
    const attempted: AgentCli[] = [];
    const successScript =
      `console.log(JSON.stringify({ type: 'result', result: 'fallback completed the stage' }));`;

    const result = await runAgent(successScript, {
      ...baseOptions(dir),
      provider: undefined,
      config: config({
        agentCli: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        fallbackAgents: [
          { agentCli: 'claude-code', model: 'opus-5', effort: 'high' },
          { agentCli: 'copilot' },
        ],
      }),
      providerFactory: (agentCli) => {
        attempted.push(agentCli);
        return fakeProviderFor(
          agentCli,
          agentCli === 'codex'
            ? `console.error('usage limit reached'); process.exit(1);`
            : undefined,
        );
      },
    });

    expect(attempted).toEqual(['codex', 'claude-code']);
    expect(result).toMatchObject({
      ok: true,
      usageLimited: false,
      agentCli: 'claude-code',
      model: 'opus-5',
    });
    expect(result.output).toContain('fallback completed the stage');
    expect(result.attempts).toMatchObject([
      {
        agentCli: 'codex',
        model: 'gpt-5.6-sol',
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
        costUsd: null,
      },
      {
        agentCli: 'claude-code',
        model: 'opus-5',
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
        costUsd: null,
      },
    ]);
    // The usage-limited attempt still reports the time it burned before dying.
    expect(result.attempts?.every((attempt) => attempt.elapsedMs >= 0)).toBe(true);
    const aggregateLog = readFileSync(path.join(dir, 'runs', 'agent.stream.log'), 'utf8');
    expect(aggregateLog).toContain('attempt 1: codex');
    expect(aggregateLog).toContain('attempt 2: claude-code');
  });

  it('starts the next stage with the highest-priority CLI not known to be limited', async () => {
    const dir = tempDir();
    const availability = new AgentAvailabilityTracker(() => Date.now());
    const cfg = config({
      agentCli: 'codex',
      fallbackAgents: [
        { agentCli: 'claude-code' },
        { agentCli: 'copilot' },
      ],
    });
    const firstAttempts: AgentCli[] = [];
    const secondAttempts: AgentCli[] = [];

    const first = await runAgent(
      `console.log(JSON.stringify({ type: 'result', result: 'claude completed' }));`,
      {
        ...baseOptions(dir),
        provider: undefined,
        config: cfg,
        availability,
        providerFactory: (agentCli) => {
          firstAttempts.push(agentCli);
          return fakeProviderFor(
            agentCli,
            agentCli === 'codex'
              ? `console.error('usage limit reached'); process.exit(1);`
              : undefined,
          );
        },
      },
    );

    const second = await runAgent(
      `console.log(JSON.stringify({ type: 'result', result: 'next stage completed' }));`,
      {
        ...baseOptions(dir),
        provider: undefined,
        config: cfg,
        availability,
        providerFactory: (agentCli) => {
          secondAttempts.push(agentCli);
          return fakeProviderFor(agentCli);
        },
      },
    );

    expect(first.ok).toBe(true);
    expect(firstAttempts).toEqual(['codex', 'claude-code']);
    expect(second.ok).toBe(true);
    expect(second.agentCli).toBe('claude-code');
    expect(secondAttempts).toEqual(['claude-code']);
  });

  it('rechecks shared limits before launching each fallback', async () => {
    const dir = tempDir();
    const availability = new AgentAvailabilityTracker(() => Date.now());
    const attempted: AgentCli[] = [];
    let spawned = 0;

    const result = await runAgent('unused', {
      ...baseOptions(dir),
      provider: undefined,
      config: config({
        agentCli: 'codex',
        fallbackAgents: [
          { agentCli: 'claude-code' },
          { agentCli: 'copilot' },
        ],
      }),
      availability,
      onSpawn: () => {
        spawned += 1;
        if (spawned === 1) {
          availability.markLimited('claude-code', {
            scope: 'session',
            resetsAtMs: null,
          });
        }
      },
      providerFactory: (agentCli) => {
        attempted.push(agentCli);
        return fakeProviderFor(
          agentCli,
          agentCli === 'codex'
            ? `console.error('usage limit reached'); process.exit(1);`
            : `console.log(JSON.stringify({ type: 'result', result: 'completed' }));`,
        );
      },
    });

    expect(result.ok).toBe(true);
    expect(result.agentCli).toBe('copilot');
    expect(attempted).toEqual(['codex', 'copilot']);
  });

  it('reconsiders a higher-priority CLI that resets during the stage', async () => {
    const dir = tempDir();
    let nowMs = 0;
    const availability = new AgentAvailabilityTracker(() => nowMs);
    availability.markLimited('codex', { scope: 'session', resetsAtMs: null });
    const attempted: AgentCli[] = [];

    const result = await runAgent('unused', {
      ...baseOptions(dir),
      provider: undefined,
      config: config({
        agentCli: 'codex',
        fallbackAgents: [
          { agentCli: 'claude-code' },
          { agentCli: 'copilot' },
        ],
      }),
      availability,
      onSpawn: () => {
        nowMs = 15 * 60_000;
      },
      providerFactory: (agentCli) => {
        attempted.push(agentCli);
        return fakeProviderFor(
          agentCli,
          agentCli === 'claude-code'
            ? `console.error('usage limit reached'); process.exit(1);`
            : `console.log(JSON.stringify({ type: 'result', result: 'completed' }));`,
        );
      },
    });

    expect(result.ok).toBe(true);
    expect(result.agentCli).toBe('codex');
    expect(attempted).toEqual(['claude-code', 'codex']);
  });

  it('continues past an ordinary fallback failure when the primary was already limited', async () => {
    const dir = tempDir();
    const availability = new AgentAvailabilityTracker(() => Date.now());
    availability.markLimited('codex', { scope: 'session', resetsAtMs: null });
    const attempted: AgentCli[] = [];

    const result = await runAgent('unused', {
      ...baseOptions(dir),
      provider: undefined,
      config: config({
        agentCli: 'codex',
        fallbackAgents: [
          { agentCli: 'claude-code' },
          { agentCli: 'copilot' },
        ],
      }),
      availability,
      providerFactory: (agentCli) => {
        attempted.push(agentCli);
        return fakeProviderFor(
          agentCli,
          agentCli === 'claude-code'
            ? `console.error('authentication failed'); process.exit(1);`
            : `console.log(JSON.stringify({ type: 'result', result: 'completed' }));`,
        );
      },
    });

    expect(result.ok).toBe(true);
    expect(result.agentCli).toBe('copilot');
    expect(attempted).toEqual(['claude-code', 'copilot']);
  });

  it('does not clear a newer shared limit when an in-flight session succeeds', async () => {
    const dir = tempDir();
    const availability = new AgentAvailabilityTracker(() => Date.now());
    let marked = false;

    await runAgent(
      `console.log(JSON.stringify({ type: 'result', result: 'completed' }));`,
      {
        ...baseOptions(dir),
        provider: undefined,
        config: config({
          agentCli: 'codex',
          fallbackAgents: [{ agentCli: 'claude-code' }],
        }),
        availability,
        onSpawn: () => {
          if (!marked) {
            marked = true;
            availability.markLimited('codex', {
              scope: 'session',
              resetsAtMs: null,
            });
          }
        },
        providerFactory: (agentCli) => fakeProviderFor(agentCli),
      },
    );

    const attempted: AgentCli[] = [];
    const next = await runAgent(
      `console.log(JSON.stringify({ type: 'result', result: 'completed' }));`,
      {
        ...baseOptions(dir),
        provider: undefined,
        config: config({
          agentCli: 'codex',
          fallbackAgents: [{ agentCli: 'claude-code' }],
        }),
        availability,
        providerFactory: (agentCli) => {
          attempted.push(agentCli);
          return fakeProviderFor(agentCli);
        },
      },
    );

    expect(next.agentCli).toBe('claude-code');
    expect(attempted).toEqual(['claude-code']);
  });

  it('starts no agent session when every configured CLI is still known to be limited', async () => {
    const dir = tempDir();
    const availability = new AgentAvailabilityTracker(() => Date.now());
    const cfg = config({
      agentCli: 'codex',
      fallbackAgents: [
        { agentCli: 'claude-code' },
        { agentCli: 'copilot' },
      ],
    });

    const exhausted = await runAgent('unused', {
      ...baseOptions(dir),
      provider: undefined,
      config: cfg,
      availability,
      providerFactory: (agentCli) =>
        fakeProviderFor(
          agentCli,
          `console.error('usage limit reached'); process.exit(1);`,
        ),
    });
    expect(exhausted.usageLimited).toBe(true);

    const attempted: AgentCli[] = [];
    const cached = await runAgent('unused', {
      ...baseOptions(dir),
      provider: undefined,
      config: cfg,
      availability,
      providerFactory: (agentCli) => {
        attempted.push(agentCli);
        return fakeProviderFor(agentCli);
      },
    });

    expect(cached.usageLimited).toBe(true);
    expect(cached.ok).toBe(false);
    expect(cached.usageLimitDetails).toMatchObject({
      scope: 'session',
      retryAtMs: expect.any(Number),
    });
    expect(attempted).toEqual([]);
  });

  it('keeps advancing through the priority chain across later stages', async () => {
    const dir = tempDir();
    const availability = new AgentAvailabilityTracker(() => Date.now());
    const cfg = config({
      agentCli: 'codex',
      fallbackAgents: [
        { agentCli: 'claude-code' },
        { agentCli: 'copilot' },
      ],
    });
    const firstAttempts: AgentCli[] = [];
    const secondAttempts: AgentCli[] = [];
    const thirdAttempts: AgentCli[] = [];

    await runAgent(
      `console.log(JSON.stringify({ type: 'result', result: 'claude completed' }));`,
      {
        ...baseOptions(dir),
        provider: undefined,
        config: cfg,
        availability,
        providerFactory: (agentCli) => {
          firstAttempts.push(agentCli);
          return fakeProviderFor(
            agentCli,
            agentCli === 'codex'
              ? `console.error('usage limit reached'); process.exit(1);`
              : undefined,
          );
        },
      },
    );

    await runAgent(
      `console.log(JSON.stringify({ type: 'result', result: 'copilot completed' }));`,
      {
        ...baseOptions(dir),
        provider: undefined,
        config: cfg,
        availability,
        providerFactory: (agentCli) => {
          secondAttempts.push(agentCli);
          return fakeProviderFor(
            agentCli,
            agentCli === 'claude-code'
              ? `console.error('usage limit reached'); process.exit(1);`
              : undefined,
          );
        },
      },
    );

    await runAgent(
      `console.log(JSON.stringify({ type: 'result', result: 'next stage completed' }));`,
      {
        ...baseOptions(dir),
        provider: undefined,
        config: cfg,
        availability,
        providerFactory: (agentCli) => {
          thirdAttempts.push(agentCli);
          return fakeProviderFor(agentCli);
        },
      },
    );

    expect(firstAttempts).toEqual(['codex', 'claude-code']);
    expect(secondAttempts).toEqual(['claude-code', 'copilot']);
    expect(thirdAttempts).toEqual(['copilot']);
  });

  it('restores a higher-priority CLI when its retry window opens', async () => {
    const dir = tempDir();
    let nowMs = 10_000;
    const availability = new AgentAvailabilityTracker(() => nowMs);
    const cfg = config({
      agentCli: 'codex',
      fallbackAgents: [{ agentCli: 'claude-code' }],
    });

    await runAgent(
      `console.log(JSON.stringify({ type: 'result', result: 'claude completed' }));`,
      {
        ...baseOptions(dir),
        provider: undefined,
        config: cfg,
        availability,
        providerFactory: (agentCli) =>
          fakeProviderFor(
            agentCli,
            agentCli === 'codex'
              ? `console.error('usage limit reached'); process.exit(1);`
              : undefined,
          ),
      },
    );

    nowMs += 15 * 60_000;
    const attempted: AgentCli[] = [];
    const result = await runAgent(
      `console.log(JSON.stringify({ type: 'result', result: 'codex restored' }));`,
      {
        ...baseOptions(dir),
        provider: undefined,
        config: cfg,
        availability,
        providerFactory: (agentCli) => {
          attempted.push(agentCli);
          return fakeProviderFor(agentCli);
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.agentCli).toBe('codex');
    expect(attempted).toEqual(['codex']);
  });

  it('continues through an ordinary fallback failure after usage-limit failover has begun', async () => {
    const dir = tempDir();
    const attempted: AgentCli[] = [];

    const result = await runAgent('unused', {
      ...baseOptions(dir),
      provider: undefined,
      config: config({
        agentCli: 'codex',
        fallbackAgents: [
          { agentCli: 'claude-code' },
          { agentCli: 'copilot' },
        ],
      }),
      providerFactory: (agentCli) => {
        attempted.push(agentCli);
        const script =
          agentCli === 'codex'
            ? `console.error('usage limit reached'); process.exit(1);`
            : agentCli === 'claude-code'
              ? `console.error('authentication failed'); process.exit(1);`
              : `console.log(JSON.stringify({ type: 'result', result: 'copilot completed' }));`;
        return fakeProviderFor(agentCli, script);
      },
    });

    expect(attempted).toEqual(['codex', 'claude-code', 'copilot']);
    expect(result).toMatchObject({ ok: true, usageLimited: false, agentCli: 'copilot' });
  });

  it('does not wait when every fallback was tried but one failed for a non-limit reason', async () => {
    const dir = tempDir();
    const attempted: AgentCli[] = [];

    const result = await runAgent('unused', {
      ...baseOptions(dir),
      provider: undefined,
      config: config({
        agentCli: 'codex',
        fallbackAgents: [
          { agentCli: 'claude-code' },
          { agentCli: 'copilot' },
        ],
      }),
      providerFactory: (agentCli) => {
        attempted.push(agentCli);
        const script =
          agentCli === 'claude-code'
            ? `console.error('authentication failed'); process.exit(1);`
            : `console.error('usage limit reached'); process.exit(1);`;
        return fakeProviderFor(agentCli, script);
      },
    });

    expect(attempted).toEqual(['codex', 'claude-code', 'copilot']);
    expect(result).toMatchObject({
      ok: false,
      usageLimited: false,
      agentCli: 'claude-code',
    });
  });

  it('reports usageLimited only after every distinct fallback CLI is exhausted', async () => {
    const dir = tempDir();
    const attempted: AgentCli[] = [];

    const result = await runAgent('unused', {
      ...baseOptions(dir),
      provider: undefined,
      config: config({
        agentCli: 'codex',
        fallbackAgents: [
          { agentCli: 'claude-code' },
          { agentCli: 'copilot' },
        ],
      }),
      providerFactory: (agentCli) => {
        attempted.push(agentCli);
        const scope = agentCli === 'codex' ? 'weekly usage limit reached' : 'usage limit reached';
        return fakeProviderFor(agentCli, `console.error(${JSON.stringify(scope)}); process.exit(1);`);
      },
    });

    expect(attempted).toEqual(['codex', 'claude-code', 'copilot']);
    expect(result.ok).toBe(false);
    expect(result.usageLimited).toBe(true);
    expect(result.usageLimitDetails).toMatchObject({ scope: 'session', resetsAtMs: null });
    expect(result.sessionId).toBeNull();
  });

  it('waits for the candidate with the earliest effective retry target', async () => {
    const dir = tempDir();
    const soonResetSeconds = Math.floor((Date.now() + 2 * 60_000) / 1000);
    const lateResetSeconds = Math.floor((Date.now() + 30 * 60_000) / 1000);

    const result = await runAgent('unused', {
      ...baseOptions(dir),
      provider: undefined,
      config: config({
        agentCli: 'codex',
        fallbackAgents: [
          { agentCli: 'claude-code' },
          { agentCli: 'copilot' },
        ],
      }),
      providerFactory: (agentCli) => {
        const message =
          agentCli === 'codex'
            ? `usage limit reached {"resetsAt":${soonResetSeconds}}`
            : agentCli === 'claude-code'
              ? 'usage limit reached'
              : `weekly usage limit reached {"resetsAt":${lateResetSeconds}}`;
        return fakeProviderFor(
          agentCli,
          `console.error(${JSON.stringify(message)}); process.exit(1);`,
        );
      },
    });

    expect(result.agentCli).toBe('codex');
    expect(result.usageLimitDetails).toMatchObject({
      scope: 'session',
      resetsAtMs: soonResetSeconds * 1000,
    });
  });

  it('does not hide a non-usage provider failure behind fallback agents', async () => {
    const dir = tempDir();
    const attempted: AgentCli[] = [];

    const result = await runAgent('unused', {
      ...baseOptions(dir),
      provider: undefined,
      config: config({
        agentCli: 'codex',
        fallbackAgents: [{ agentCli: 'claude-code' }],
      }),
      providerFactory: (agentCli) => {
        attempted.push(agentCli);
        return fakeProviderFor(agentCli, `console.error('authentication failed'); process.exit(1);`);
      },
    });

    expect(attempted).toEqual(['codex']);
    expect(result.ok).toBe(false);
    expect(result.usageLimited).toBe(false);
  });
});

describe('runAgent peak context', () => {
  it('keeps the highest single request, so a compaction cannot lower it', async () => {
    const dir = tempDir();
    const script = [
      `console.log(JSON.stringify({ type: 'turn', contextTokens: 120000 }));`,
      `console.log(JSON.stringify({ type: 'turn', contextTokens: 229900 }));`,
      // A compaction drops the next request's context right back down.
      `console.log(JSON.stringify({ type: 'turn', contextTokens: 40000 }));`,
      `console.log(JSON.stringify({ type: 'result', result: 'ok' }));`,
    ].join(' ');

    const result = await runAgent(script, baseOptions(dir));
    expect(result.peakContextTokens).toBe(229_900);
  });

  it('is null when the provider reports no per-request usage', async () => {
    const dir = tempDir();
    const result = await runAgent(
      `console.log(JSON.stringify({ type: 'result', result: 'ok' }));`,
      baseOptions(dir),
    );
    expect(result.peakContextTokens).toBeNull();
  });
});

describe('runAgent infrastructure-fault retries', () => {
  const retrying = (attempts: number): Partial<LoopConfig> => ({
    agentRetries: { attempts, initialDelayMs: 1, maxDelayMs: 1 },
  });

  /** Silences the retry notice while still letting the test read it back. */
  function captureLog(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  it('retries the same CLI in place and keeps the stage on success', async () => {
    const dir = tempDir();
    const attempted: AgentCli[] = [];
    const { lines, restore } = captureLog();

    try {
      const result = await runAgent(
        `console.log(JSON.stringify({ type: 'result', result: 'second attempt worked' }));`,
        {
          ...baseOptions(dir),
          provider: undefined,
          config: config(retrying(2)),
          providerFactory: (agentCli) => {
            attempted.push(agentCli);
            return fakeProviderFor(
              agentCli,
              attempted.length === 1
                ? `console.error('API Error: Connection closed mid-response'); process.exit(1);`
                : undefined,
            );
          },
        },
      );

      // Same provider both times: a provider fault must not consume a fallback slot.
      expect(attempted).toEqual(['cursor', 'cursor']);
      expect(result).toMatchObject({
        ok: true,
        usageLimited: false,
        infraRetries: { retries: 1, signature: 'connection-dropped' },
      });
      expect(result.output).toContain('second attempt worked');
      // Usage from the lost session is still counted, or --budget undercounts it.
      expect(result.attempts).toHaveLength(2);
      expect(lines.join('\n')).toContain('provider fault (connection-dropped)');
    } finally {
      restore();
    }

    expect(readFileSync(path.join(dir, 'runs', 'agent.stream.attempt-1-cursor.log'), 'utf8')).toContain(
      'Connection closed mid-response',
    );
    const aggregate = readFileSync(path.join(dir, 'runs', 'agent.stream.log'), 'utf8');
    expect(aggregate).toContain('attempt 1: cursor');
    expect(aggregate).toContain('attempt 2: cursor');
  });

  it('reattaches the dead session so the retry keeps its work', async () => {
    const dir = tempDir();
    const scripts: string[] = [];
    const { restore } = captureLog();

    try {
      await runAgent(`console.log(JSON.stringify({ type: 'result', result: 'done' }));`, {
        ...baseOptions(dir),
        provider: undefined,
        config: config(retrying(1)),
        providerFactory: (agentCli) => {
          const provider = fakeProviderFor(
            agentCli,
            scripts.length === 0
              ? `console.log('{"session_id":"sess-42"}'); console.error('overloaded_error'); process.exit(1);`
              : undefined,
          );
          return {
            ...provider,
            buildArgs: (input) => {
              const args = provider.buildArgs(input);
              scripts.push(args[1] ?? '');
              return args;
            },
            buildResumeArgs: (input) => {
              const args = provider.buildResumeArgs(input);
              scripts.push(args?.[1] ?? '');
              return args;
            },
          };
        },
      });
    } finally {
      restore();
    }

    expect(scripts).toHaveLength(2);
    expect(scripts[1]).toContain('resume:sess-42');
    expect(scripts[1]).toContain('cut off by a fault on the provider side');
  });

  it('gives up after the configured attempts and names the fault', async () => {
    const dir = tempDir();
    const attempted: AgentCli[] = [];
    const { restore } = captureLog();

    try {
      const result = await runAgent('unused', {
        ...baseOptions(dir),
        provider: undefined,
        config: config(retrying(1)),
        providerFactory: (agentCli) => {
          attempted.push(agentCli);
          return fakeProviderFor(agentCli, `console.error('overloaded_error'); process.exit(1);`);
        },
      });

      expect(attempted).toEqual(['cursor', 'cursor']);
      expect(result).toMatchObject({
        ok: false,
        usageLimited: false,
        infraSignature: 'overloaded',
        infraRetries: { retries: 1, signature: 'overloaded' },
      });
    } finally {
      restore();
    }
  });

  it('leaves a usage limit to the wait policy instead of retrying it', async () => {
    const dir = tempDir();
    const attempted: AgentCli[] = [];

    const result = await runAgent('unused', {
      ...baseOptions(dir),
      provider: undefined,
      config: config(retrying(2)),
      providerFactory: (agentCli) => {
        attempted.push(agentCli);
        return fakeProviderFor(agentCli, `console.error('usage limit reached'); process.exit(1);`);
      },
    });

    expect(attempted).toEqual(['cursor']);
    expect(result).toMatchObject({ ok: false, usageLimited: true, infraSignature: null });
    expect(result.infraRetries).toBeUndefined();
  });

  it('does not retry an ordinary session failure', async () => {
    const dir = tempDir();
    const attempted: AgentCli[] = [];

    const result = await runAgent('unused', {
      ...baseOptions(dir),
      provider: undefined,
      config: config(retrying(2)),
      providerFactory: (agentCli) => {
        attempted.push(agentCli);
        return fakeProviderFor(agentCli, `console.error('3 tests failed'); process.exit(1);`);
      },
    });

    expect(attempted).toEqual(['cursor']);
    expect(result).toMatchObject({ ok: false, infraSignature: null });
  });

  it('does not classify a successful session that merely mentions a fault', async () => {
    const dir = tempDir();
    const result = await runAgent(
      `console.log(JSON.stringify({ type: 'text', text: 'the retry test asserts on ECONNRESET' })); console.log(JSON.stringify({ type: 'result', result: 'done' }));`,
      { ...baseOptions(dir), config: config(retrying(2)) },
    );

    expect(result).toMatchObject({ ok: true, infraSignature: null });
  });
});
