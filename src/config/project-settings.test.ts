import { describe, expect, it } from 'vitest';

import {
  resolveProjectEnv,
  resolveProjectPreflight,
  resolveProjectUsageLimitPolicy,
  resolveProjectVerifyCmd,
} from './project-settings.js';

describe('resolveProjectVerifyCmd', () => {
  it('prefers the project override, falling back to the global command', () => {
    const config = {
      verifyCmd: 'pnpm verify',
      projects: { 'PRD-006': { verifyCmd: 'pnpm --filter web verify' }, docs: {} },
    };
    expect(resolveProjectVerifyCmd(config, 'PRD-006')).toBe('pnpm --filter web verify');
    expect(resolveProjectVerifyCmd(config, 'docs')).toBe('pnpm verify');
    expect(resolveProjectVerifyCmd(config, 'unlisted')).toBe('pnpm verify');
  });

  it('returns null when neither the project nor the global command is set', () => {
    expect(resolveProjectVerifyCmd({ verifyCmd: null, projects: {} }, 'PRD-006')).toBeNull();
  });
});

describe('resolveProjectUsageLimitPolicy', () => {
  const config = {
    usageLimits: { session: 'wait' as const, weekly: 'stop' as const },
    projects: {
      'PRD-006': { usageLimits: { weekly: 'wait' as const } },
      docs: {},
    },
  };

  it('prefers the project override per scope, falling back to the global map', () => {
    expect(resolveProjectUsageLimitPolicy(config, 'PRD-006', 'weekly')).toBe('wait');
    expect(resolveProjectUsageLimitPolicy(config, 'PRD-006', 'session')).toBe('wait');
    expect(resolveProjectUsageLimitPolicy(config, 'docs', 'weekly')).toBe('stop');
    expect(resolveProjectUsageLimitPolicy(config, 'unlisted', 'weekly')).toBe('stop');
  });
});

describe('resolveProjectEnv', () => {
  const config = {
    env: { NX_DAEMON: 'false', DATABASE_URL: 'postgres://shared' },
    projects: { web: { env: { DATABASE_URL: 'postgres://web-fixtures' } }, docs: {} },
  };

  it('merges key by key, so a project adds to the cross-cutting settings', () => {
    const env = resolveProjectEnv(config, 'web', { PATH: '/usr/bin' });
    expect(env).toEqual({
      PATH: '/usr/bin',
      NX_DAEMON: 'false',
      DATABASE_URL: 'postgres://web-fixtures',
    });
  });

  it('leaves projects without an override on the global env', () => {
    expect(resolveProjectEnv(config, 'docs', {}).DATABASE_URL).toBe('postgres://shared');
    expect(resolveProjectEnv(config, 'unlisted', {}).DATABASE_URL).toBe('postgres://shared');
  });

  it('lets config values win over the inherited environment', () => {
    expect(resolveProjectEnv(config, 'docs', { NX_DAEMON: 'true' }).NX_DAEMON).toBe('false');
  });
});

describe('resolveProjectPreflight', () => {
  const probe = { cmd: 'pg_isready', message: 'start the database' };
  const projectProbe = { cmd: 'curl -sf localhost:3000/health', message: 'start the web fixtures' };

  it("replaces the global probe rather than adding to it — two probes would say the same thing twice", () => {
    const config = { preflight: probe, projects: { web: { preflight: projectProbe }, docs: {} } };
    expect(resolveProjectPreflight(config, 'web')).toEqual(projectProbe);
    expect(resolveProjectPreflight(config, 'docs')).toEqual(probe);
  });

  it('is null when nothing is configured — the feature is off by default', () => {
    expect(resolveProjectPreflight({ preflight: null, projects: {} }, 'web')).toBeNull();
  });
});
