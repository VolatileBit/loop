import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  LOCAL_CONFIG_FILE_NAME,
  loadConfig,
} from './load-config.js';

const tempRoots: string[] = [];

function makeRoot(config?: unknown): string {
  const root = mkdtempSync(path.join(tmpdir(), 'loop-config-'));
  tempRoots.push(root);
  if (config !== undefined) {
    const contents = typeof config === 'string' ? config : JSON.stringify(config, null, 2);
    writeFileSync(path.join(root, CONFIG_FILE_NAME), contents);
  }
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('spec config names', () => {
  it('reads legacy input keys into the canonical runtime shape', () => {
    const root = makeRoot({ prdsDir: 'docs/prd', projects: { gallery: { prd: 'docs/prd/gallery.md' } } });
    const config = loadConfig(root, { env: {} });
    expect(config.specsDir).toBe('docs/prd');
    expect(config.projects.gallery).toEqual({ spec: 'docs/prd/gallery.md' });
    expect(config).not.toHaveProperty('prdsDir');
  });

  it('prefers canonical keys within a file, while preserving local overlay precedence', () => {
    const root = makeRoot({ specsDir: 'specs', prdsDir: 'old',
      projects: { gallery: { spec: 'specs/gallery.md', prd: 'old/gallery.md' } } });
    const tracked = loadConfig(root, { env: {} });
    expect(tracked.specsDir).toBe('specs');
    expect(tracked.projects.gallery).toEqual({ spec: 'specs/gallery.md' });
    writeFileSync(path.join(root, LOCAL_CONFIG_FILE_NAME), JSON.stringify({ prdsDir: '.planning',
      projects: { gallery: { prd: '.planning/gallery.md' } } }));
    const local = loadConfig(root, { env: {} });
    expect(local.specsDir).toBe('.planning');
    expect(local.projects.gallery).toEqual({ spec: '.planning/gallery.md' });
  });

  it('still validates values supplied with legacy names', () => {
    expect(() => loadConfig(makeRoot({ prdsDir: 42 }), { env: {} })).toThrow(/specsDir/);
    expect(() => loadConfig(makeRoot({ projects: { gallery: { prd: false } } }), { env: {} })).toThrow(/projects.gallery.spec/);
  });
});

describe('loadConfig missing file', () => {
  it('returns built-in defaults when no loop.config.json exists', () => {
    const config = loadConfig(makeRoot(), { env: {} });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('defaults verifyCmd to null (commands fail fast later, not at load time)', () => {
    const config = loadConfig(makeRoot(), { env: {} });
    expect(config.verifyCmd).toBeNull();
  });
});

describe('loadConfig file parsing', () => {
  it('reads values from loop.config.json', () => {
    const root = makeRoot({
      agentCli: 'claude-code',
      model: 'sonnet-5',
      fallbackAgents: [
        { agentCli: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
        { agentCli: 'copilot' },
      ],
      verifyCmd: 'pnpm test',
      issuesDir: 'tickets',
      specsDir: 'docs/specs',
      commitExcludePaths: ['.workspaces'],
      triageLabels: { done: 'agent-done', readyForAgent: 'ready-for-agent' },
      stages: { review: { agentCli: 'codex', model: 'gpt-5.5' } },
      maxParallelRuns: 3,
    });
    const config = loadConfig(root, { env: {} });

    expect(config.agentCli).toBe('claude-code');
    expect(config.model).toBe('sonnet-5');
    expect(config.fallbackAgents).toEqual([
      { agentCli: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
      { agentCli: 'copilot' },
    ]);
    expect(config.verifyCmd).toBe('pnpm test');
    expect(config.issuesDir).toBe('tickets');
    expect(config.specsDir).toBe('docs/specs');
    expect(config.commitExcludePaths).toEqual(['.workspaces']);
    expect(config.triageLabels).toEqual({ done: 'agent-done', readyForAgent: 'ready-for-agent' });
    expect(config.stages).toEqual({ review: { agentCli: 'codex', model: 'gpt-5.5' } });
    expect(config.effort).toBeNull();
    expect(config.maxParallelRuns).toBe(3);
    // Unset fields keep defaults.
    expect(config.maxVerifyCycles).toBe(3);
    expect(config.worktreeEnabled).toBe(true);
  });

  it('accepts claude as a fallback alias and normalizes it to claude-code', () => {
    const config = loadConfig(
      makeRoot({
        fallbackAgents: [
          { agentCli: 'claude', model: 'opus-5', effort: 'high' },
          { agentCli: 'copilot' },
        ],
      }),
      { env: {} },
    );

    expect(config.fallbackAgents).toEqual([
      { agentCli: 'claude-code', model: 'opus-5', effort: 'high' },
      { agentCli: 'copilot' },
    ]);
  });

  it('rejects malformed or duplicate fallback agents', () => {
    expect(() => loadConfig(makeRoot({ fallbackAgents: {} }), { env: {} })).toThrow(
      /"fallbackAgents" must be an array/,
    );
    expect(() => loadConfig(makeRoot({ fallbackAgents: [{}] }), { env: {} })).toThrow(
      /"fallbackAgents\[0\]\.agentCli"/,
    );
    expect(() =>
      loadConfig(makeRoot({ fallbackAgents: [{ agentCli: 'codex', temperature: 1 }] }), { env: {} }),
    ).toThrow(/unknown field "temperature"/);
    expect(() =>
      loadConfig(
        makeRoot({ fallbackAgents: [{ agentCli: 'copilot' }, { agentCli: 'copilot' }] }),
        { env: {} },
      ),
    ).toThrow(/duplicate agentCli "copilot"/);
  });

  it('throws a descriptive error on invalid JSON', () => {
    const root = makeRoot('{ not json');
    expect(() => loadConfig(root, { env: {} })).toThrow(/loop\.config\.json: invalid JSON/);
  });

  it('throws on unknown top-level fields', () => {
    const root = makeRoot({ verifyCommand: 'pnpm test' });
    expect(() => loadConfig(root, { env: {} })).toThrow(/unknown field\(s\): verifyCommand/);
  });

  it('throws on a non-object config', () => {
    const root = makeRoot('[1, 2]');
    expect(() => loadConfig(root, { env: {} })).toThrow(/must be a JSON object/);
  });

  it('throws on mis-typed fields', () => {
    expect(() => loadConfig(makeRoot({ maxVerifyCycles: 'three' }), { env: {} })).toThrow(
      /"maxVerifyCycles" must be a positive number/,
    );
    expect(() => loadConfig(makeRoot({ agentCli: 'gemini' }), { env: {} })).toThrow(
      /"agentCli" must be one of: cursor, claude-code, codex, copilot/,
    );
    expect(() => loadConfig(makeRoot({ triageLabels: { finished: 'done' } }), { env: {} })).toThrow(
      /unknown role "finished"/,
    );
    expect(() => loadConfig(makeRoot({ stages: { deploy: {} } }), { env: {} })).toThrow(
      /unknown stage "deploy"/,
    );
    expect(() => loadConfig(makeRoot({ stages: { review: { temperature: 1 } } }), { env: {} })).toThrow(
      /unknown field "temperature"/,
    );
    expect(() => loadConfig(makeRoot({ effort: '' }), { env: {} })).toThrow(/"effort" must be a non-empty string/);
    expect(() => loadConfig(makeRoot({ stages: { review: { effort: '' } } }), { env: {} })).toThrow(
      /"stages\.review\.effort" must be a non-empty string/,
    );
  });

  it('reads effort from config file and CLI override', () => {
    const root = makeRoot({ effort: 'medium', stages: { review: { effort: 'high' } } });
    expect(loadConfig(root, { env: {} }).effort).toBe('medium');
    expect(loadConfig(root, { env: {}, cli: { effort: 'low' } }).effort).toBe('low');
  });

  it('rejects zero/negative maxParallelRuns', () => {
    expect(() => loadConfig(makeRoot({ maxParallelRuns: 0 }), { env: {} })).toThrow(/maxParallelRuns/);
    expect(() => loadConfig(makeRoot({ maxParallelRuns: -2 }), { env: {} })).toThrow(/maxParallelRuns/);
  });

  it('parses the projects map and defaults it to empty', () => {
    expect(loadConfig(makeRoot({}), { env: {} }).projects).toEqual({});
    const root = makeRoot({
      projects: {
        'PRD-006': { verifyCmd: 'pnpm --filter web verify', spec: 'docs/specs/PRD-006-web.md' },
        hotfixes: { verifyCmd: 'pnpm test' },
      },
    });
    expect(loadConfig(root, { env: {} }).projects).toEqual({
      'PRD-006': { verifyCmd: 'pnpm --filter web verify', spec: 'docs/specs/PRD-006-web.md' },
      hotfixes: { verifyCmd: 'pnpm test' },
    });
  });

  it('rejects malformed projects entries', () => {
    expect(() => loadConfig(makeRoot({ projects: [] }), { env: {} })).toThrow(/"projects" must be an object/);
    expect(() => loadConfig(makeRoot({ projects: { a: { baseBranch: 'x' } } }), { env: {} })).toThrow(
      /unknown field "baseBranch"/,
    );
    expect(() => loadConfig(makeRoot({ projects: { a: { verifyCmd: '' } } }), { env: {} })).toThrow(
      /"projects\.a\.verifyCmd" must be a non-empty string/,
    );
  });

  it('parses per-project and goal usageLimits overrides as partial policy maps', () => {
    const root = makeRoot({
      projects: { 'PRD-006': { usageLimits: { weekly: 'wait' } } },
      goal: { usageLimits: { session: 'stop' } },
    });
    const config = loadConfig(root, { env: {} });
    expect(config.projects['PRD-006']).toEqual({ usageLimits: { weekly: 'wait' } });
    expect(config.goal.usageLimits).toEqual({ session: 'stop' });
    expect(config.goal.usageLimits.weekly).toBeUndefined();

    expect(() =>
      loadConfig(makeRoot({ projects: { a: { usageLimits: { daily: 'wait' } } } }), { env: {} }),
    ).toThrow(/"projects\.a\.usageLimits" has unknown scope "daily"/);
    expect(() => loadConfig(makeRoot({ goal: { usageLimits: { session: 'retry' } } }), { env: {} })).toThrow(
      /must be "wait" or "stop"/,
    );
  });

  it('parses webhooks and defaults them to empty', () => {
    expect(loadConfig(makeRoot({}), { env: {} }).webhooks).toEqual([]);
    const root = makeRoot({
      webhooks: [
        { url: 'https://hooks.example/a', format: 'slack' },
        { url: '${HOOK_URL}', events: ['run-completed'], headers: { authorization: 'Bearer ${T}' } },
      ],
    });
    expect(loadConfig(root, { env: {} }).webhooks).toEqual([
      { url: 'https://hooks.example/a', format: 'slack' },
      { url: '${HOOK_URL}', events: ['run-completed'], headers: { authorization: 'Bearer ${T}' } },
    ]);
  });

  it('rejects malformed webhooks', () => {
    expect(() => loadConfig(makeRoot({ webhooks: {} }), { env: {} })).toThrow(/"webhooks" must be an array/);
    expect(() => loadConfig(makeRoot({ webhooks: [{}] }), { env: {} })).toThrow(/url must be a non-empty string/);
    expect(() => loadConfig(makeRoot({ webhooks: [{ url: 'x', events: ['progress'] }] }), { env: {} })).toThrow(
      /events must be an array of/,
    );
    expect(() => loadConfig(makeRoot({ webhooks: [{ url: 'x', format: 'xml' }] }), { env: {} })).toThrow(
      /format must be "generic" or "slack"/,
    );
    expect(() => loadConfig(makeRoot({ webhooks: [{ url: 'x', retries: 2 }] }), { env: {} })).toThrow(
      /unknown field/,
    );
  });

  it('parses usageLimits with wait/stop defaults per scope', () => {
    expect(loadConfig(makeRoot({}), { env: {} }).usageLimits).toEqual({ session: 'wait', weekly: 'stop' });
    expect(loadConfig(makeRoot({ usageLimits: { weekly: 'wait' } }), { env: {} }).usageLimits).toEqual({
      session: 'wait',
      weekly: 'wait',
    });
    expect(() => loadConfig(makeRoot({ usageLimits: { daily: 'wait' } }), { env: {} })).toThrow(
      /unknown scope "daily"/,
    );
    expect(() => loadConfig(makeRoot({ usageLimits: { session: 'retry' } }), { env: {} })).toThrow(
      /must be "wait" or "stop"/,
    );
  });
});

describe('loadConfig precedence', () => {
  it('env var beats config file, CLI flag beats env var', () => {
    const root = makeRoot({ model: 'from-config', verifyCmd: 'config-cmd' });

    const envOnly = loadConfig(root, { env: { LOOP_MODEL: 'from-env' } });
    expect(envOnly.model).toBe('from-env');
    expect(envOnly.verifyCmd).toBe('config-cmd');

    const withCli = loadConfig(root, {
      env: { LOOP_MODEL: 'from-env', LOOP_VERIFY_CMD: 'env-cmd' },
      cli: { model: 'from-flag' },
    });
    expect(withCli.model).toBe('from-flag');
    expect(withCli.verifyCmd).toBe('env-cmd');
  });

  it('config file beats built-in default; default applies when nothing is set', () => {
    const root = makeRoot({ maxReviewCycles: 5 });
    const config = loadConfig(root, { env: {} });
    expect(config.maxReviewCycles).toBe(5);
    expect(config.maxVerifyCycles).toBe(3);
  });

  it('maps boolean-style env vars (LOOP_SHOW_THINKING=0, LOOP_NO_WORKTREE=1)', () => {
    const config = loadConfig(makeRoot(), {
      env: { LOOP_SHOW_THINKING: '0', LOOP_NO_WORKTREE: '1' },
    });
    expect(config.showThinking).toBe(false);
    expect(config.worktreeEnabled).toBe(false);
  });

  it('supports numeric env vars including legacy aliases', () => {
    const config = loadConfig(makeRoot(), {
      env: {
        LOOP_MAX_VERIFY_FIX_CYCLES: '7',
        LOOP_MAX_REVIEW_ROUNDS: '4',
        LOOP_AGENT_TIMEOUT_MS: '1000',
        LOOP_MAX_PARALLEL_RUNS: '2',
      },
    });
    expect(config.maxVerifyCycles).toBe(7);
    expect(config.maxReviewCycles).toBe(4);
    expect(config.agentTimeoutMs).toBe(1000);
    expect(config.maxParallelRuns).toBe(2);
  });

  it('preferred env var beats its legacy alias', () => {
    const config = loadConfig(makeRoot(), {
      env: { LOOP_MAX_VERIFY_CYCLES: '5', LOOP_MAX_VERIFY_FIX_CYCLES: '9' },
    });
    expect(config.maxVerifyCycles).toBe(5);
  });
});

describe('loop.config.local.json overlay', () => {
  function writeConfigs(tracked: unknown, local?: unknown): string {
    const root = mkdtempSync(path.join(tmpdir(), 'loop-overlay-'));
    tempRoots.push(root);
    writeFileSync(path.join(root, CONFIG_FILE_NAME), JSON.stringify(tracked));
    if (local !== undefined) {
      writeFileSync(path.join(root, LOCAL_CONFIG_FILE_NAME), JSON.stringify(local));
    }
    return root;
  }

  it('lets a machine-local value win over the tracked one', () => {
    const root = writeConfigs({ verifyCmd: 'npm test', model: 'sonnet-5' }, { model: 'opus-5' });
    const config = loadConfig(root, { env: {} });
    expect(config.model).toBe('opus-5');
    expect(config.verifyCmd).toBe('npm test');
  });

  it('adds a project entry rather than replacing the tracked map', () => {
    const root = writeConfigs(
      { projects: { shared: { verifyCmd: 'npm test' } } },
      { projects: { mine: { verifyCmd: 'npm run quick' } } },
    );
    const config = loadConfig(root, { env: {} });
    expect(Object.keys(config.projects).sort()).toEqual(['mine', 'shared']);
  });

  it('replaces arrays outright — a local chain is a whole statement, not an addition', () => {
    const root = writeConfigs(
      { fallbackAgents: [{ agentCli: 'codex' }, { agentCli: 'cursor' }] },
      { fallbackAgents: [{ agentCli: 'copilot' }] },
    );
    expect(loadConfig(root, { env: {} }).fallbackAgents).toEqual([{ agentCli: 'copilot' }]);
  });

  it('validates the merged result, not each file in isolation', () => {
    const root = writeConfigs({ verifyCmd: 'npm test' }, { maxVerifyCycles: 'lots' });
    expect(() => loadConfig(root, { env: {} })).toThrow(/maxVerifyCycles/);
  });

  it('works with no tracked config at all', () => {
    const root = writeConfigs({}, { verifyCmd: 'npm run local-verify' });
    expect(loadConfig(root, { env: {} }).verifyCmd).toBe('npm run local-verify');
  });
});
