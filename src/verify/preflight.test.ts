import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../config/load-config.js';
import type { LoopConfig } from '../config/types.js';
import { describePreflightFailure, runPreflight } from './preflight.js';

function config(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe('runPreflight', () => {
  it('is ready when no probe is configured', () => {
    const result = runPreflight(config(), 'PRD-001', process.cwd(), process.env);
    expect(result).toEqual({ ready: true, probe: null, output: '' });
  });

  it('is ready when the probe exits zero', () => {
    const result = runPreflight(
      config({ preflight: { cmd: 'exit 0', message: 'start the database' } }),
      'PRD-001',
      process.cwd(),
      process.env,
    );
    expect(result.ready).toBe(true);
  });

  it('captures the failure and the operator instruction', () => {
    const result = runPreflight(
      config({ preflight: { cmd: 'echo "connection refused" >&2; exit 1', message: 'run `docker compose up`' } }),
      'PRD-001',
      process.cwd(),
      process.env,
    );
    expect(result.ready).toBe(false);
    expect(result.output).toContain('connection refused');
    expect(describePreflightFailure(result)).toEqual([
      expect.stringContaining('Probe:'),
      'What to do: run `docker compose up`',
      expect.stringContaining('connection refused'),
    ]);
  });

  it("uses the project's own probe instead of the global one", () => {
    const result = runPreflight(
      config({
        preflight: { cmd: 'exit 0', message: 'global' },
        projects: { web: { preflight: { cmd: 'exit 1', message: 'start the web fixtures' } } },
      }),
      'web',
      process.cwd(),
      process.env,
    );
    expect(result.ready).toBe(false);
    expect(result.probe?.message).toBe('start the web fixtures');
  });

  it('sees the environment the verify command will see', () => {
    const result = runPreflight(
      config({ preflight: { cmd: 'test "$LOOP_PROBE" = ready', message: 'unused' } }),
      'PRD-001',
      process.cwd(),
      { ...process.env, LOOP_PROBE: 'ready' },
    );
    expect(result.ready).toBe(true);
  });
});
