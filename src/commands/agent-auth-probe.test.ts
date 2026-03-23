import { describe, expect, it, vi } from 'vitest';

import { AGENT_AUTH_PROBE, probeAgentAuth } from './agent-auth-probe.js';

describe('probeAgentAuth', () => {
  it('passes when claude auth status reports loggedIn', () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
      stderr: '',
      error: undefined,
    }));

    const outcome = probeAgentAuth('claude', AGENT_AUTH_PROBE['claude-code']!, spawn as never);
    expect(outcome).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith('claude', ['auth', 'status'], expect.objectContaining({ timeout: 8000 }));
  });

  it('fails when claude auth status reports loggedIn false', () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: '',
      error: undefined,
    }));

    const outcome = probeAgentAuth('claude', AGENT_AUTH_PROBE['claude-code']!, spawn as never);
    expect(outcome).toEqual({ ok: false, reason: 'not logged in (claude auth status)' });
  });

  it('passes when codex login status exits 0', () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: 'Logged in using ChatGPT\n',
      stderr: '',
      error: undefined,
    }));

    const outcome = probeAgentAuth('codex', AGENT_AUTH_PROBE.codex!, spawn as never);
    expect(outcome).toEqual({ ok: true });
  });

  it('fails when codex login status exits non-zero', () => {
    const spawn = vi.fn(() => ({
      status: 1,
      stdout: '',
      stderr: 'Not logged in\n',
      error: undefined,
    }));

    const outcome = probeAgentAuth('codex', AGENT_AUTH_PROBE.codex!, spawn as never);
    expect(outcome).toEqual({ ok: false, reason: 'Not logged in' });
  });

  it('passes when cursor agent status exits 0', () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: '✓ Logged in as user@example.com\n',
      stderr: '',
      error: undefined,
    }));

    const outcome = probeAgentAuth('cursor', AGENT_AUTH_PROBE.cursor!, spawn as never);
    expect(outcome).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith('cursor', ['agent', 'status'], expect.objectContaining({ timeout: 8000 }));
  });

  it('surfaces spawn timeout as failure reason', () => {
    const spawn = vi.fn(() => ({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawnSync ETIMEDOUT'),
    }));

    const outcome = probeAgentAuth('cursor', AGENT_AUTH_PROBE.cursor!, spawn as never);
    expect(outcome).toEqual({ ok: false, reason: 'spawnSync ETIMEDOUT' });
  });

  it('fails when claude auth status exits non-zero', () => {
    const spawn = vi.fn(() => ({
      status: 1,
      stdout: '',
      stderr: 'auth service unavailable',
      error: undefined,
    }));

    const outcome = probeAgentAuth('claude', AGENT_AUTH_PROBE['claude-code']!, spawn as never);
    expect(outcome).toEqual({ ok: false, reason: 'auth service unavailable' });
  });

  it('fails when claude auth status returns malformed JSON', () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: 'not json',
      stderr: '',
      error: undefined,
    }));

    const outcome = probeAgentAuth('claude', AGENT_AUTH_PROBE['claude-code']!, spawn as never);
    expect(outcome).toEqual({ ok: false, reason: 'not json' });
  });

  it('fails when cursor agent status exits non-zero', () => {
    const spawn = vi.fn(() => ({
      status: 1,
      stdout: '',
      stderr: 'Not authenticated',
      error: undefined,
    }));

    const outcome = probeAgentAuth('cursor', AGENT_AUTH_PROBE.cursor!, spawn as never);
    expect(outcome).toEqual({ ok: false, reason: 'Not authenticated' });
  });

  it('surfaces spawn errors other than timeout', () => {
    const spawn = vi.fn(() => ({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('ENOENT: claude not found'),
    }));

    const outcome = probeAgentAuth('claude', AGENT_AUTH_PROBE['claude-code']!, spawn as never);
    expect(outcome).toEqual({ ok: false, reason: 'ENOENT: claude not found' });
  });
});
